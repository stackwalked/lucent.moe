# Wishlist

Everything discussed so far that isn't built yet. A backlog, not a spec: entries leave as they land.

## Gate and tooling

- clang-tidy runs as a build-dependent, cached `native:lint`, with the first native project.
- C++ style: `.clang-format` and `.clang-tidy`, under discussion. clang-format then joins dprint via exec.
- luau-lsp analysis, pinned with the first Luau code.
- TS tooling returns with the first TS project: bun workspaces, Biome and strict `tsc` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) as inherited moon tasks. The working setup is in commit 5dbd739.
- Complete `.protolock`: moon, bun, cmake, ninja and uv were installed before the lockfile was on, so they have no recorded hashes.
- Architecture boundaries are enforced by moon constraints, CMake visibility and dependency-cruiser. Nothing depends on `research/`.
- Remaining custom checks, each a standalone uv script in `tools/lint` (no CLI, no shared package), landing when they have inputs:
  - file placement;
  - the doc-ref checker (paths and symbols named in docs must exist), once `docs/` maps exist;
  - no hand-edits to generated files.
- ast-grep for syntactic rules (banned APIs per layer, `__try`/`catch` only in `contain()`), pinned with its first rule.
- Generated code:
  - carries a header marker;
  - is skipped by format and lint;
  - is marked `linguist-generated`;
  - has a freshness check in `:check`.
- `.github/workflows` stays thin and only calls moon.
- Later:
  - a fence tool for briefs;
  - commit trailers (`Decision:`, `Found-in:`, `Breaks:`, `Supersedes:`);
  - a check for stale worktrees and branches.

## C++ toolchain

- clang-cl + lld-link, LLVM 23.1.5 via `tools/proto/llvm.toml`. Done.
- Switch the plugin to `.tar.zst` once proto can unpack it (about 3x smaller download).
- `-std=c++2c`, headers only. A modules trial spike goes in `research/lab/` later.
- MSVC STL, not libc++. Language gaps (reflection, contracts, `template for`) are clang's either way, and
  the library delta at 23.1.5 vs STL 14.51 is mixed. Revisit when clang ships P2996: `<meta>` is
  expected to come with libc++ (unverified).
- A pwsh dev-shell helper (vswhere → `Enter-VsDevShell`) that every native moon task runs through.
- CMake presets + Ninja. `dev` and `release` to start; an ASan preset when fuzzing needs one.
- CMake fails on configure when VS Build Tools are below a version floor. The STL, SDK and CRT come from the latest VS.
- `native/cmake/` provides `lucent_library/module/executable`, which own all flags. A lint bans raw `add_library`, `add_executable` and `target_compile_options`.
- Warnings: `-Wall -Wextra -Werror`, plus `-Wshadow`, with a trial of `-Wconversion`. `/external:` flags silence third-party headers.
- Static CRT everywhere.
- vcpkg:
  - a custom triplet that chainloads the clang-cl toolchain;
  - manifest mode with a pinned baseline;
  - VS-bundled vcpkg;
  - overlay ports instead of vendored source.
- Verify zydis, safetyhook, luau and tracy build under clang-cl.
- Debug info: `/Z7` plus PDBs. Never shipped; archived per release.
- Release hygiene: `/Brepro`, `-ffile-prefix-map`, `/pdbaltpath`, `/GR-`, ThinLTO.
- `/GR-` everywhere. Checked on 23.1.5 with a static-CRT exe: catch-by-type still works, and every
  polymorphic class name disappears from the binary, but each thrown type keeps its `.?AU...@@`
  name. So `raise()` throws one fault type.

## C++ dialect

Being settled one topic at a time. Decisions land as `.clang-format`, `.clang-tidy`, ast-grep rules,
or, for what no tool can check, `native/AGENTS.md`.

Principles (decided; they break ties between later rules):

1. Judge readability at the call site. Feature and domain code is plain; machinery lives in a few kit
   libraries.
2. One way to write each thing. Duplicates are banned, by a tool where possible.
3. A call shows what it does: can it fail, mutate, take ownership, touch game memory. Results are
   `[[nodiscard]]`, moves are visible, game access takes a token, no non-const reference
   out-parameters.
4. Types carry the rules. A mistake that can be a compile error is one; comments never hold an
   invariant a type could.
5. Values first: aggregates, designated initializers, defaulted comparison. Identity types are
   non-copyable and say so.
6. Control flow is visible: no implicit conversions, `throw` only via `raise()` into `contain()`,
   only the named error macros branch, no mutable global without a named owner.
7. Newest form when it reads better and the pinned toolchain supports it; the older idiom is then
   banned.
8. Our memory and the game's are handled differently: copies out, `game_ptr`/`field`, provenance on
   every offset, never mixed in one expression.

Feature ledger (decided). It lands as code: a `toolchain_probe.cpp` that `static_assert`s each
feature-test macro we rely on, and ban rules in clang-tidy/ast-grep that name the replacement.

- Core: concepts/`requires`, designated init, `<=>`/defaulted `==`, `constexpr`/`consteval`/
  `if consteval`, `constinit` globals, deducing `this`, `using enum`, structured bindings,
  init-statements, `= delete("why")`, `_`, `static operator()`, `[[nodiscard]]`/`[[maybe_unused]]`;
  `expected`, `optional`, `span`, `string_view`, `array`, `unique_ptr`, ranges + `ranges::to`,
  `print`/`format`, `bit_cast`/`byteswap`/`to_underlying`, `flat_map`/`flat_set`,
  `move_only_function`, `source_location`, `atomic`, `chrono`.
- Narrow: pack indexing, binding packs, constexpr placement `new` (kit machinery only); `#embed` for
  blobs (needs `-Wno-c23-extensions` on those files); `mdspan` for real grids;
  `[[likely]]`/`[[unlikely]]` with a profile; `stacktrace` dev-only; `launder` in kit memory
  primitives.
- Banned → replacement: `typedef` → `using`; `NULL`/`0` → `nullptr`; `enable_if` → `requires`; CRTP →
  deducing `this`; unscoped `enum` → `enum class`; `#define` constants → `constexpr`; C casts → named
  casts/`bit_cast`; `reinterpret_cast` → `raw` only; `new`/`delete` → `make_unique`; `std::bind` →
  lambdas; `std::function` → `move_only_function`/our `function_ref`; `printf`/iostreams →
  `print`/`format`; `assert` → `LUCENT_INVARIANT`; `throw` → `raise()`.
- Banned outright: coroutines and `std::generator`, iostreams, `shared_ptr`, `vector<bool>`,
  `std::endl`, `goto`, `std::any`, `std::regex`, `std::async`, `std::rand`, direct `system_clock::now`,
  `volatile`, `inline namespace`, trivial relocatability, RTTI (`dynamic_cast`, `typeid`).
- `variant`/`visit`: decided with composition.

Naming (decided):

- snake_case for everything we name; `LUCENT_` UPPER_CASE for macros only (`#pragma once`, no
  guards); CamelCase for template parameters only. A variable is named for its role, never its
  type's name.
- Struct fields unmarked; private class members `m_`. No `s_`/`g_`.
- Mutators are verbs; queries are nouns without `get_`; anything bool starts with `is_`/`has_`/
  `can_`/`should_`, stated positively. `to_x()` copies, `as_x()` views, `from_x()` constructs. No
  `try_`: `result<T>` says it.
- Types are nouns, concepts adjectives, enums singular with unprefixed enumerators. Suffixes are
  reserved: `_id`, `_handle`, `_view`, `_token`. No `_t`, no unit suffixes (units are types).
- Abbreviations only from: `id`, `ptr`, `fn`, `ui`, `io`, `rng`, `src`/`dst`; single letters for
  loop indices and math. Internal namespaces are `detail`.
- Game identifiers keep the game's spelling (`C_CSPlayerPawn`, `m_iHealth`), only inside the
  game-memory layer, which the naming check skips.
- Enforced by clang-tidy `readability-identifier-naming` and ast-grep (`get_`, `_t`); the rest goes
  to `native/AGENTS.md`.

Vocabulary types (decided):

- `lucent/prelude.hpp`: `i8`–`i64`, `u8`–`u64`, `isize`/`usize`, `f32`/`f64`, `uptr`. `int`, `long`,
  `unsigned`, `short` only in foreign signatures.
- Counts, indices, offsets are `isize`; `usize` only where std or an ABI demands it.
- `-Wconversion` and `-Wsign-conversion` are required. Narrowing via `narrow<T>()` (invariant on
  loss), bits via `bit_cast`. `std::byte` is opaque memory, `u8` a number.
- `char` is UTF-8; `string` owns, `string_view` borrows. No `char8_t`/`u8string`. `wchar_t` only at
  Win32, converted by `to_utf8`/`to_wide`. `fixed_string<N>` for template arguments.
- `T` value, `unique_ptr<T>` sole owner, `T&` non-null borrow, `T*` nullable borrow (never owning,
  never game memory), `span`/`string_view` borrowed ranges. No `reference_wrapper`.
- `optional<T>`: absence is normal. `result<T>` = `expected<T, error>`: failure with a reason. No
  success `bool`s; `result<void>`.
- Ids and handles are empty enum classes. Quantities with arithmetic are dedicated types (`degrees`,
  `radians`, `tick`); time is `chrono` via the injected clock; bit flags are `flags<E>`. Kit math
  types are plain aggregates; the game's are mirrored and converted with `from_game`/`to_game`.
- Containers: `vector`, `array`, `flat_map`/`flat_set`; `unordered_map` with a profiling reason.
  `map`, `set`, `list`, `forward_list`, `deque` banned. `move_only_function` owns callables,
  `function_ref` borrows them.
- std gaps (`inplace_vector`, `function_ref`) are written in `lucent::stdx` with std's name and API,
  only when first needed, and replaced by a `using` once a probe shows std has them.

Topics still to settle: declarations, composition, functions
and control flow, generic code, concurrency and game memory, structure, preprocessor, comments,
formatting, enforcement.

## Kit

- Boot handshake with the mapper (`boot_info`):
  - image and readiness (unwind tables, TLS);
  - host and build ids;
  - the lease blob and the game-data blob;
  - the session channel.
- The mapper does the Windows loader's full job: unwind tables (`RtlAddFunctionTable`), static TLS, CRT and static init. Exceptions work natively, with no `_CxxThrowException` replacement.
- Lifecycle: boot → resolve → attach → run → detach → unload.
  - Safe points.
  - In-flight hook counting.
  - Unhooking only once no hook call is in progress.
- Hook manager:
  - all-or-nothing install and remove;
  - in-flight counters per hook;
  - `hook_access` created per call.
- Access boundary:
  - `read_access`/`write_access` tokens, `game_ptr` and `field`;
  - a feature touching game memory is a compile error.
- A `raw` escape hatch: explicit, findable with grep, counted in `:check`. Uses get promoted into proper APIs.
- Error model:
  - `result<T>` for expected failures;
  - `LUCENT_ENSURE` → `fault` → the feature is disabled;
  - `LUCENT_INVARIANT` → die (`__fastfail`);
  - foreign faults (access violations) are caught at the boundary.
- `contain()`:
  - an SEH outer layer and a C++ inner layer;
  - the only `__try`/`catch` sites (enforced by lint);
  - `throw` only through `raise()`.
- Features never hold kit resources while touching game memory. This closes the `/EHs` destructor gap.
- Feature registry:
  - `feature_id`, hashed at compile time;
  - states: unavailable, unentitled, off, on, failed;
  - a lapse policy per feature;
  - `wiring` records registrations;
  - `slot` dispatch: state check, `contain()`, stats;
  - changes applied at safe points, with immutable published views.
- A failed feature stays off until a human resets it. Maybe also remember the game build it failed on.
- Features never depend on features (lint: no feature header includes another). Shared logic goes into domains or plain libraries.
- An explicit feature list (`features/all.cpp`), no static self-registration. Products can strip features at compile time.
- Settings:
  - `describe()` drives config, menu and scripts;
  - per-tick snapshots;
  - generate `describe()` with C++26 reflection if Clang ships it (unverified).
- Config store: profiles, undo, scopes. Per-weapon scope may need to be a real dimension.
- Binds: `bind_slot`. Activity (a held key) is separate from lifecycle (on/off).
- Overlay contract (device + frame). Widgets live in `libs/ui`, the menu in `libs/menu`.
- Lease client: verify, renew, lapse, and feed entitlements to the registry.
- Resolution:
  - `server_only<T>` has no fallback slot; `derivable<T>` may derive locally;
  - validators;
  - per-build availability.
- Dev channel, stats and incident sink, compiled out of release (enforced in CMake).
- An injectable clock.
- Named kit worker threads, joined on unload, run inside `contain()`.

## cs2 game layer

- Domains with concrete APIs. Each one states its own rule for resolving competing features.
- `world`:
  - a plain-value snapshot with index+serial entity handles;
  - built every frame stage;
  - published to the render thread through a triple buffer;
  - built on demand only once a profile shows it matters.
- `static_world`: collision data kept for the life of a map.
- `command`: createmove in stages (movement, aim_view, aim_shot, trigger, scripts).
  - One owner per stage.
  - Stage tokens for writes only one stage may make.
- `prediction`: a what-if repredict owned by the game layer (scratch write, then restore). The riskiest code in the layer.
- `view`: the mouse model.
  - The view is set through the game's own setter at frame stage.
  - The matching counts are owed to and settled into the next command.
  - Requests add up.
- `scene_draw`:
  - restyle per primitive, chosen by precedence;
  - a material override scoped to one call;
  - the original can be called again.
- `removals`: a set of vetoes. Any enabled feature can ask.
- `events`: game events, plus the local shot (predicted vs. server-confirmed).
- `inventory` service:
  - desired state plus a reconcile state machine;
  - its own hooks;
  - irreversible schema additions declared, not hidden;
  - behavior on lease lapse and on detach.
- `queries`: trace, visible, inaccuracy. Values only, game thread only.
- Movement:
  - the planner owns the movement stage, and goals propose plans;
  - requests from other domains (`request_still`);
  - the planner gets redesigned from scratch.
- `targeting`: a pure shared computation, memoized per tick.
- `trigger`: decide whether "on target" means the view or the silent-aim angle.
- Script host:
  - a script is a feature;
  - one stage with many owners, in load order, below built-in features;
  - read-only schema reads by name;
  - scripts get values, not live handles. This breaks compatibility with the old `ext`.
- Walking skeleton first: map → hook present → draw a rectangle → unload cleanly.
- Extraction candidate: "one owner by precedence" (command stages, scene restyle, movement goals), once the third copy exists.
- Split the `domains` object by phase when it grows.

## Server inputs and licensing integrity

- The lease and game data travel on separate channels.
- Game data keys and types are declared in game code (`server_value<T>`).
  - The build exports a manifest, and server tooling validates bundles against it.
  - Only the container schema lives in `contracts/`.
- Bundle:
  - game, build, revision;
  - entries with hashed keys;
  - overrides (can only force features off);
  - an ed25519 signature.
- Delivery:
  - the loader identifies the build, fetches or caches the bundle, and passes it in the boot handshake;
  - live revisions arrive over the session, are applied at a safe point, and the affected requirements are re-resolved.
- The release module discovers nothing. `libs/probe` (sig, schema, RTTI) is tooling and dev only, banned from release presets. Gate schema offsets too, so there's one rule.
- Every server value is validated. A bad value makes a requirement unavailable; it never crashes.
- Bundles are encrypted per session (key from the lease), expire with the lease, and are decrypted, used and wiped.
- Entitlement is enforced by withholding data. Data is delivered lazily, per feature.
- No labeled tables:
  - recipes (load-time derivation bytecode);
  - plans (copy plans run by a native executor).
- Per-release format rotation from a seed:
  - recipe opcodes;
  - plan encoding;
  - key derivation;
  - struct field order.

  The server encoder and the module decoders come from the same seed, with a contract test between them.
- Per-session watermarking: equivalent but distinct bundles.
- Integrity as key material:
  - `measure`/`mix`/`derive` ops, with regions chosen by the server per session;
  - the runner measures itself;
  - server-side challenge/response.
- Measurement accounts for relocations and fixups. A contract test checks the expected hashes, and mismatch telemetry is tagged with the release seed.
- Debugger and VM checks are signals only: risk scoring on the server, acted on later. Never a local gate, and never gate on hypervisor detection (VBS).
- Never respond where a tamper is detected. Responses are delayed and decoupled.
- Bundle pipeline per game update: automated scan, manifest check, human sign-off, publish. Update-day latency is a product metric.
- Dev: `loader-dev` takes local bundles signed with a dev key that release builds reject.
- Later:
  - fixups into code immediates;
  - per-user diversified builds;
  - server-sent feature logic, only if replaying data proves to be enough for crackers.

## Protection toolchain

- The `LUCENT_VIRT` annotation now. Mark the runner, decryption, lease and integrity code as it's written.
- Compile-time virtualizer:
  - starts as a lab project and graduates to `tools/`;
  - opt-in and release-only;
  - cold functions only, verified by tooling.
- Seeded per release, with the seed recorded, `/Brepro` preserved, and differential tests (plain vs. virtualized).
- Verify that LLVM pass plugins load in clang-cl from the prebuilt release. If not: our own LLVM build (which changes the pin) or a post-link rewriter.
- One VM generator for both the outer VM and the recipe VM, plus the server encoder.
- The recipe runner is fully virtualized. The plan executor stays native.

## Repo and platform

- `contracts/` and `products/` at the root. Codegen only once hand-mirrored types get painful.
- `docs/` is an index of per-project README maps only.
- Binaries out of git, keyed by build id, in a local cache. Signing keys never in the tree.
- `research/`:
  - `kb/` pages carry frontmatter (target, last observed build, status);
  - `scratch/` gitignored once it exists;
  - `lab/`.
- Find homes for leftovers from the old repo:
  - cs2 `presets`, `assets`, `scenarios`, `bench`, `examples`;
  - den `bot` (→ `connectors/discord`), `geo`, `keys`.
- A remote, then GitHub issues for deferred items.

## Open

- Release string hygiene (log stripping, hashed ids, string encryption). It shapes the logging API.
- Isolating our allocations from the game's heap.
- A generic "revise" round in an arbiter vs. a planner per domain.
- Script precedence policy (a product decision).
- Release behavior when there's no server and no cached bundle.
- RTTI and exceptions: confirm the `/GR-` decision when the first DLL boundary is built.
