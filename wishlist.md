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
- Verify that catch-by-type works under clang-cl with RTTI off.

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
