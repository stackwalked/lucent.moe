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
3. A call shows what it does: can it fail, mutate, take ownership, touch foreign memory. Results are
   `[[nodiscard]]`, moves are visible, foreign access takes a token, no non-const reference
   out-parameters.
4. Types carry the rules. A mistake that can be a compile error is one; comments never hold an
   invariant a type could.
5. Values first: aggregates, designated initializers, defaulted comparison. Identity types are
   non-copyable and say so.
6. Control flow is visible: no implicit conversions, `throw` only via `raise()` into `contain()`,
   only the named error macros branch, no mutable global without a named owner.
7. Newest form when it reads better and the pinned toolchain supports it; the older idiom is then
   banned.
8. Our memory and foreign memory (owned by someone else: a game, another target) are handled
   differently: copies out, `foreign_ptr`/`field`, provenance on every offset, never mixed in one
   expression.

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
- Foreign identifiers keep their own spelling (`C_CSPlayerPawn`, `m_iHealth`), only inside the
  foreign-memory layer, which the naming check skips.
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
  never foreign memory, which is `foreign_ptr`), `span`/`string_view` borrowed ranges. No `reference_wrapper`.
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

Declarations (decided):

- Every function is `auto name(params) -> type`, `-> void` included. Deduced return types only for
  lambdas and unspellable `detail` templates.
- Local `auto` only when the type is on the same line (casts, `narrow<T>`, `make_unique<T>`, `T{...}`)
  or unspellable (lambdas, views, iterators).
- West `const`. Locals `const` unless mutated (`misc-const-correctness`). No top-level `const` on
  value parameters.
- `T x = value;` for a value of that type; `T x{parts...}` to build one; designated initializers for
  two or more fields; parentheses only where braces pick the wrong constructor. Nothing
  uninitialized; one declaration per line, at first use.
- No `[[nodiscard]]` attribute: clang-tidy `bugprone-unused-return-value` with
  `CheckedFunctions: '^::lucent::.*'` and `AllowCastToVoid: false`; discard with
  `std::ignore = f();`. Checked on 23.1.5: void calls, assignment operators and `std::ignore` pass.
- `noexcept` only on moves, `swap`, and foreign entry points. `constexpr` on pure header functions,
  `consteval` for what must be compile time, `inline constexpr` header constants, `explicit`
  constructors and conversions, `override` without `virtual`.
- Specifier order: attributes, `static`, `inline`, `constexpr`/`consteval`, then
  `auto name(...) const noexcept -> T`.

Composition (decided):

- `struct` is a pure aggregate (public data, no constructors, only defaulted `==`/`<=>`), with behavior
  in free functions beside it. `class` has an invariant: all data private, constructors establish
  it, no plain getter/setter pairs. Identity classes are non-copyable via `= delete("why")`.
- No `init()` methods: fallible construction is a private constructor plus a static named constructor
  returning `result<T>`. Rule of zero everywhere except the kit's owning types. No `const` or
  reference data members.
- Members only for `m_` access or a core verb/query; everything else is a free function.
- Polymorphism: concepts at compile time; `variant` + kit `match` for closed sets (`get`,
  `holds_alternative`, bare `visit` banned); interfaces (no data, pure virtuals, virtual dtor) with
  `final` implementations for open sets; `function_ref`/`move_only_function` for one operation;
  deducing `this` instead of const/non-const pairs.
- No implementation inheritance, no middle layers, no inheriting std types. Foreign layout mirrors
  may mirror the target's inheritance.
- Operators: defaulted comparisons; arithmetic only on quantity types, as hidden friends (the only
  ADL we use); `|` for ranges and `flags<E>`, `[]` for containers; never overload `&&`, `||`, `,`,
  unary `&`, `->*`. No user-defined literals of our own; std `sv` and chrono literals allowed.

Functions and control flow (decided):

- Parameters: cheap inputs (trivially copyable, two words or less) by value, others `const T&`;
  `span`/`string_view` by value; sinks by value then `std::move`; several outputs as a named struct,
  never `pair`/`tuple` in our signatures; non-const `T&` only for non-copyable (identity) types. No
  out or in-out value parameters, no `T&&` outside generic forwarding.
- No `bool` parameters (ast-grep), no default arguments (`fuchsia-default-arguments-declarations`).
  More than three parameters, or two adjacent of the same type
  (`bugprone-easily-swappable-parameters`), means a parameter struct with designated initializers.
- Guard clauses, no `else` after `return`, `readability-function-cognitive-complexity` at 25.
- Recursion: `misc-no-recursion` on in code that can run on foreign threads (hooks, features,
  domains, kit runtime). Elsewhere (our threads, compile time, tools, tests, lab) recursion is
  allowed where natural; inside the module that needs `NOLINT(misc-no-recursion)` naming the threads
  and the depth bound. Nested `.clang-tidy` files turn it off outside the module. Checked on 23.1.5:
  the check flags runtime, `constexpr` and `consteval` recursion, not variadic templates.
- `switch` over our enums has no `default` (`-Wswitch`), followed by kit `unreachable()`, which
  fails fast.
- Range-for; `views::enumerate` for indices; named `ranges::` algorithms over hand loops
  (`modernize-use-ranges`, no iterator pairs, no `for_each`); view pipelines of three stages at most.
  Unnested ternaries for value choices only; `while (true)`.
- Lambdas: `[&]` only when the lambda doesn't outlive its statement; otherwise explicit captures,
  `[this]` spelled out, init-captures for moves. Over about ten lines becomes a named function.
- Errors: `LUCENT_TRY(decl, expr)` is the only propagation; handle with `if (!r)`, default with
  `.value_or()`; `.value()` banned; `bugprone-unchecked-optional-access`. `LUCENT_ENSURE` (the world
  surprised us → feature disabled) and `LUCENT_INVARIANT` (our bug → `__fastfail`) sit at the top as
  preconditions, moving to `pre(...)` when clang ships contracts. `error`'s shape is decided with
  the kit's first fallible function: one kit-wide type, cheap to copy, no heap, no strings in
  release.

Generic code (decided):

- Templates and concepts live in kit libraries; feature and domain code declares none (lambdas
  aside), enforced by ast-grep per path.
- Every template parameter is constrained (floor: a std concept such as `std::movable`); no bare
  `typename T`, no unconstrained `auto` parameters. `typename`, never `class`.
- Placement: `C auto x` when the type is named once; `template <C T>` when named more than once; a
  `requires` clause only for relational or non-type constraints. std concepts first; ours state
  meaning, not member checklists.
- `if constexpr` over tag dispatch; `requires` expressions over `void_t`; folds and `Ts...[i]` over
  recursive variadics; concepts over `::value` traits; our value traits are `is_x` variable
  templates. Every `static_assert` has a message stating the rule.
- Reopen when clang ships reflection (`describe()`, enum introspection).

Concurrency and foreign memory (decided):

- Our threads come only from kit `worker` (`std::jthread`, named, inside `contain()`, joined on
  unload); `std::thread`/`CreateThread` banned elsewhere.
- Thread affinity is a type: hook dispatch creates `main_thread`/`render_thread` tokens, taken by
  functions that must run there.
- Nothing blocks on a foreign thread. Data crosses threads only through kit `published<T>`
  (immutable snapshots), `channel<T>` (messages to workers) and atomics; feature and domain code
  never sees a mutex or atomic. Every atomic op names its memory order; `relaxed` needs a comment.
- No function-local statics except `constexpr` (ast-grep): checked on 23.1.5 `/O2 /MT`, their guard
  reads `gs:0x58[_tls_index]` against `_Init_thread_epoch` on every call. No `thread_local` outside
  the kit, and there only once the mapper's TLS is verified on threads that predate us.
- Only the foreign-memory layer and snapshot builders touch foreign memory, with
  `read_access`/`write_access`; foreign calls go through `foreign_fn<Sig>` and need `write_access`.
- Copies out, never references in: `read(access, ptr) -> result<T>`, bulk reads into our containers,
  `read_string(access, ptr, max_length)`. Every value passes `from_foreign` (enum validity, capped
  counts, pointers stay `foreign_ptr`) before it's ours.
- Every walk over foreign structures is bounded (kit `walk(start, limit, next)`; over the limit is
  `LUCENT_ENSURE`). A `foreign_ptr` never outlives its tick; snapshots hold handles and values.
- Offsets are `field<Owner, T>`, grouped per foreign type, each with provenance or from a
  `server_value`. Layout mirrors are `static_assert`-checked and copied out whole.

Structure (decided):

- Layout: `native/cmake/` (helpers), `core/` (prelude, result/error, macros, narrow, match, flags,
  fixed_string, stdx), `libs/<name>/` (standalone, depend on core only), `kit/` (runtime),
  `targets/<name>/` (`foreign/`, `domains/`, `features/`, the module), `tools/<name>/` (native
  executables). Created only when code needs them. Layering points down: core ← libs ← kit ←
  targets, enforced by moon constraints and CMake visibility.
- One name in four places: a project's name is its namespace (`lucent::<name>[::<sub>]`), CMake target
  (`lucent::<name>`), moon project and commit scope. Grouping directories (`libs/`, `targets/`,
  `tools/`) don't enter names; collisions are resolved by renaming when they happen.
- A library is `include/lucent/<name>/` (public API) and `src/` (sources and private headers).
  `VERIFY_INTERFACE_HEADER_SETS` compiles each public header alone. One main type or concept per
  header, named after it; `.hpp`/`.cpp`; definitions in `.cpp` unless template, `constexpr` or
  trivial. A plain-path alternative needs a clang VFS overlay or header maps; rejected as tooling
  magic.
- Includes: angle brackets with the full path for everything; quotes only for private headers in
  the same `src/`. Order: own header, std, Windows SDK, third-party, `lucent/`, private.
  `misc-include-cleaner`. Forward declarations only of your own library's types.
- `lucent/prelude.hpp` is force-included by `lucent_library()` (`/FI`) and listed in
  `misc-include-cleaner`'s `IgnoreHeaders`.
- std names always fully qualified; no `using` declarations or namespace aliases, except literal
  namespaces at function scope. `detail` for private namespaces.
- File-local code in an anonymous namespace; `static` free functions banned;
  `misc-use-internal-linkage`.

Tests (decided):

- Catch2 v3 via vcpkg; doctest if it fails under `/GR-` (unverified). Tests build with the product's
  flags, warnings and lints.
- `tests/<unit>_test.cpp` per project, one executable via `lucent_test(<name> ...)`, an inherited
  moon `test` task. Test names are behavior sentences.
- Pure `constexpr` logic is tested only by `static_assert`.
- `read_access` carries its memory source (live process or a test buffer), so the foreign layer is
  tested with real `foreign_ptr`/`field`/`read` against laid-out bytes. No mocks.
- `LUCENT_INVARIANT` goes through a host-installed handler: `__fastfail` in the module,
  throws `invariant_violated` in tests. No death tests.
- Every external-input parser (bundles, recipes, plans, config) gets a libFuzzer target in
  `tests/fuzz/` under the ASan preset from its first commit.
- In-target behavior and feel get manual test lists, not rigs.

Preprocessor (decided):

- Closed macro list, all `LUCENT_`: `TRY`, `ENSURE`, `INVARIANT`, `VIRT`, and possibly one logging
  macro once release string hygiene is settled. Enforced by `cppcoreguidelines-macro-usage`
  `AllowedRegexp`. Defined in one core header; each evaluates its arguments once. No X-macros, no
  function-like macros as functions, no `#`/`##` elsewhere.
- Build configuration is `lucent::build::*` constants from one generated header, branched with
  `if constexpr`. `#if` only there and where code can't compile otherwise. Dev-only code lives in
  dev-only projects release presets don't link; feature stripping goes through the feature list and
  CMake.
- Windows headers only in `src/` (includes script); `NOMINMAX` and `WIN32_LEAN_AND_MEAN` set by
  `lucent_library()`; explicit `W` APIs, never `TCHAR` macros.
- `#pragma once`. `#pragma clang diagnostic` silencing is a suppression (rule + reason, taught to
  `suppressions.py` when C++ lands). `#pragma pack` and `#pragma comment(lib)` banned.
- Standard attribute syntax (`[[clang::...]]`, `[[msvc::...]]`) over `__declspec`/`__attribute__`
  where one exists. `std::source_location` over `__FILE__`/`__LINE__` outside the allowed macros.

Comments and provenance (decided):

- `//` only, on its own line above what it explains; sentences with a capital and a period. No
  `///`, Doxygen, `@param`, or `/* */`. Public declarations get a comment only for contracts types
  can't express (thread, borrow lifetime, preconditions beyond `LUCENT_ENSURE`). Tests don't narrate.
- Every hardcoded foreign fact (field, offset, signature, vtable index, layout mirror) carries a
  `// build:` / `// found:` / `// breaks:` block, one block per group allowed, checked under
  `foreign/` by `tools/lint/provenance.py`. `found:` cites durable evidence (a `research/kb/` page,
  module + build + IDA address, a lab project), never `scratch/`. `server_value`s carry none.
- No `TODO`/`FIXME`/`HACK`/`XXX` (script); deferred work goes to the wishlist or issues. No
  commented-out code, section banners or file headers (generated-file markers aside).
- Suppressions keep the existing form: `// NOLINT(check): reason`, `// NOLINTNEXTLINE(check): reason`.

Topics still to settle: formatting, enforcement.

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
  - `read_access`/`write_access` tokens, `foreign_ptr` and `field`;
  - a feature touching foreign memory directly is a compile error.
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
- Features never hold kit resources while touching foreign memory. This closes the `/EHs` destructor gap.
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
