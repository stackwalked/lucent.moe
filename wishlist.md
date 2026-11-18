# Wishlist

Everything discussed so far that isn't built yet. A backlog, not a spec: entries leave as they land.

## Gate and tooling

- luau-lsp analysis, pinned with the first Luau code.
- TS tooling returns with the first TS project: bun workspaces, Biome and strict `tsc` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) as inherited moon tasks. The working setup is in commit 5dbd739.
- Complete `.protolock`: moon, bun, cmake, ninja and uv were installed before the lockfile was on, so they have no recorded hashes.
- Architecture boundaries are enforced by moon constraints, CMake visibility and dependency-cruiser. Nothing depends on `research/`.
- Remaining custom checks, each a standalone uv script in `tools/lint` (no CLI, no shared package), landing when they have inputs:
  - file placement;
  - the doc-ref checker (paths and symbols named in docs must exist), once `docs/` maps exist;
  - no hand-edits to generated files.
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

- Switch the plugin to `.tar.zst` once proto can unpack it (about 3x smaller download).
- A modules trial spike in `research/lab/`. The build is headers only for now.
- MSVC STL, not libc++. Language gaps (reflection, contracts, `template for`) are clang's either way, and
  the library delta at 23.1.5 vs STL 14.51 is mixed. Revisit when clang ships P2996: `<meta>` is
  expected to come with libc++ (unverified).
- An ASan preset when fuzzing needs one.
- `lucent_module()` and `lucent_executable()` join `lucent_library()`/`lucent_test()` with their first
  users. A lint bans raw `add_library`, `add_executable` and `target_compile_options` outside
  `native/cmake/`.
- vcpkg overlay ports instead of vendored source, once a port needs patching.
- Verify zydis, safetyhook, luau and tracy build under clang-cl with `/GR-` (Catch2 3.16.1 does).
- Debug info: PDBs archived per release, never shipped.
- Release hygiene: `/Brepro`, `-ffile-prefix-map`, `/pdbaltpath`, ThinLTO.

## C++ dialect

Decided in full. Landed in `native/.clang-format`, `native/.clang-tidy`, `native/cmake/lucent.cmake`,
`native/core/src/toolchain_probe.cpp`, `tools/lint/ast-grep/`, `tools/lint/suppressions.py`, and
`native/AGENTS.md` for what no tool checks. Still to land, each with the first code it applies to:

- core: `LUCENT_ENSURE` with `raise()`/`contain()`, a fail-fast `unreachable()`, `flags<E>`,
  `fixed_string`, `stdx`, and the generated `lucent::build::*` header.
- ast-grep rules:
  - templates in features and domains;
  - `std::get`, `holds_alternative`, bare `visit`, `.value()`;
  - `std::map`/`set`/`list`/`forward_list`/`deque`, `vector<bool>`, `reference_wrapper`,
    `std::function`, `std::async`, `std::rand`, `system_clock::now`, the `printf` family, `assert`,
    `char8_t`/`u8string`;
  - `int`/`long`/`unsigned`/`short` outside foreign signatures;
  - `std::thread` and `CreateThread` outside the kit;
  - `__FILE__`/`__LINE__` outside the allowed macros, `#pragma pack`, `#pragma comment(lib)`,
    `__declspec` where a standard attribute exists.
- uv scripts: `includes.py` (layering against moon dependencies, private headers, Windows headers only
  in `src/`) and `provenance.py` (with the first `foreign/`).
- `-Wunsafe-buffer-usage` off by path in the foreign-memory layer; `misc-no-recursion` off by path in
  tools and tests once something there recurses.
- libFuzzer targets for external-input parsers, under the ASan preset.
- Lab C++ config sharing (clang-format and clang-tidy only search parents), with the first lab C++
  project; likely generated copies with a freshness check.
- Reopen generic code (`describe()`, enum introspection) when clang ships reflection; preconditions
  move to `pre(...)` when it ships contracts.

## Kit

- `boot_info` grows with the mapper (v1 carries only the session ends):
  - image and readiness (unwind tables);
  - host and build ids;
  - the lease blob and the game-data blob.
- The mapper registers unwind tables (`RtlAddFunctionTable`), runs CRT and static init, and redirects
  the image's `RtlPcToFileHeader` import: the static CRT's `_CxxThrowException` asks it for the
  ThrowInfo image base, which the loader doesn't know for a mapped image.
- No static TLS in mapped modules: `lucent_module()` fails the build on a TLS directory, ast-grep bans
  `thread_local`/`__declspec(thread)`, and our code bans function-local statics. A dependency that
  needs TLS is a decision: build it with `/Zc:threadSafeInit-`, keep it out of the module, or implement
  TLS through ntdll internals with a check per Windows build.
- Lifecycle: a resolve stage between boot and attach (boot → attach → run → detach → unload exists).
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
  - `throw` only through `raise()`, which throws one fault type: under `/GR-` every thrown type
    still keeps its `.?AU...@@` name in the binary (checked on 23.1.5).
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
- Walking skeleton, on the OS loader through `loader-dev` first (lifecycle and session landed):
  1. hook `IDXGISwapChain::Present` with safetyhook and draw a rectangle with `ClearView`;
  2. unload cleanly: in-flight counting, unhook only when no call is in progress;
  3. swap the OS loader for the manual mapper; the module stays unchanged.
- Separation the first skeleton slice still owes:
  - `kit`'s lifecycle mixes the stage sequence with OS-loader unload (`FreeLibraryAndExitThread`);
    the mapper step splits them.
  - Names for `error_code` and `stage` live in the loader; they belong beside their types.
- Extraction candidate: "one owner by precedence" (command stages, scene restyle, movement goals), once the third copy exists.
- Split the `domains` object by phase when it grows.

## Facts

Foreign knowledge (RVAs, vtable slots, field and schema offsets, constants): declared, derived and
delivered. Decided topic by topic. Still open: finder vocabulary (provisionally accepted, being
tested on real data).

- Declarations are C++ in the target's foreign layer, by subsystem, and ship. A `consteval`
  constructor hashes the name, which never reaches the binary; ast-grep checks it matches the
  identifier.
- Finders are C++ in a tooling-only library per target (`targets/<game>/finders/`), linked only by
  the generator; moon layering and the release presets keep it out of the module. A finder refers
  to its fact by symbol and carries the `build:`/`found:`/`breaks:` provenance.
- The generator reuses `libs/pe` and `libs/probe`: one PE stack.
- Values never enter git. They're generated per module build into the binaries cache and published
  to the server; git holds what derives them.
- A fact's kind says what its value means; how a finder gets it is separate. Kinds:
  `method<R(Args...)>`, `global<T>`, `vtable<C>`, `slot<R(C*, Args...)>`, `field<Owner, T>`,
  `value<T>`. Schema offsets are fields. Each kind defines its load-time check:
  - method: in an executable section, at a `.pdata` function start;
  - global: in a data section, aligned for `T`;
  - vtable: in `.rdata`, 8-aligned, first entry in code;
  - slot: within its vtable's bound;
  - field: aligned for `T`, inside `Owner`'s size when that size is a fact;
  - value: the declared range.
- A fact object holds its resolved value, in a linker section the kit's fact table owns
  (`LUCENT_FACT`: `inline constinit` plus placement).
  - Resolve walks the section before attach; live revisions rewrite it only at safe points; the
    section is read-only between them.
  - The manifest is the facts the shipped code links, so a stripped feature drops its facts.
  - Spike first: inline variables fold to one copy, the section enumerates, the mapper carries it.
- Features never name facts. The foreign layer groups facts into capabilities beside them; features
  require capabilities in `features/all.cpp`; a capability is available when all its facts passed
  their checks. Reads inside a running feature don't re-check facts.
- Dev builds audit requirements: slot dispatch records the facts read during a feature's slot and
  reports any its capabilities don't cover, on first use, even when the value is valid.
- Every fact reaches the module from a bundle (in dev, a local one signed with the dev key).
  Derivation happens only in the generator.
- A module build is `(name, TimeDateStamp, SizeOfImage)`, read the same way from the file and from
  the loaded headers. It keys the binaries cache, the fact set, the server's stored set and the
  bundle section. The cache also records the file's SHA-256; nothing needs it at runtime.
- One fact set per module build.
  - A patch regenerates and publishes only the modules it touched.
  - The module checks each set's key against the loaded headers before applying its values.
  - A late-loaded module resolves when it appears; its capabilities are unavailable until then.
- A capability may be `core`: an unavailable core capability refuses the start. Everything else
  degrades on its own.
- The modules that matter are the ones the manifest's facts name. No hand-kept module list anywhere.
- A set has a revision per module build; the revision and the finders' commit are signed. The server
  serves the latest enabled revision for each reported module build.
- Steam's `buildid` and `PatchVersion` are labels for display, telemetry and update-day detection.
  They never select facts.
- Source 2 knowledge is its own layer, `native/engines/source2/`. `libs/probe` stays generic (PE,
  x64 code, patterns, MSVC RTTI).
  - `engines/source2/probe` (tooling, banned from release presets like `libs/probe`): the offline
    schema reader and the interface finder.
  - `engines/source2/harvest`: a dev-only module `loader-dev` injects, which dumps the live
    SchemaSystem into the binaries cache per module build.
  - Source 2 foreign mirrors stay in `targets/cs2` until a second Source 2 target; then they move
    to `engines/source2/foreign/`.
- Schema data comes from the module files, read offline. Provisional on a spike: the offline
  reading of 1.41.9.8 against a live harvest.
  - The generator requires the offline reading and the harvest to agree for the current build.
  - The harvester gets class data through the game's SchemaSystem calls where it can, so the two
    derivations don't share one layout mirror.
- A schema field is an ordinary finder (`source2::schema("C_BaseEntity", "m_iHealth")`).
  - The generator checks the declared `T` against the schema's type name.
  - Foreign type mirrors with schema fields declare a size fact, filled from the schema, and their
    bases; a non-zero base offset is a fact.
- Interfaces are `global<T>` facts found offline through their registration code
  (`source2::interface_instance`). Objects the game creates at runtime are reached through the
  global that holds them. Resolve never calls into the game.
- Class identity is vtable facts compared against an object's vtable pointer; is-a is an explicit
  declared set of classes.
- Validation by layer:
  - compile: ast-grep checks the name matches the identifier; owner-typed fields and typed
    signatures. Key collisions are checked by the generator over the manifest and again at resolve
    over the linked section (an invariant).
  - generation: finders unique, agreeing, acyclic. Kind checks with the whole image: method at a
    `.pdata` start, vtable through its RTTI locator, slot within the vtable's real length, field
    against the schema's size and type. Coverage both ways, matching kinds. Deltas from the
    previous build flagged for sign-off. The generator signs nothing.
  - publish: the server refuses a set whose manifest digest isn't the release's, that lacks a fact
    a `core` capability needs, or whose revision isn't newer.
  - load: bundle signature, format and module keys; the per-kind checks against the loaded image
    (`RtlLookupFunctionEntry` for methods), header reads through `contain()`. A failed fact makes
    its capabilities unavailable; telemetry reports its key and module build.
  - use: reads trust their facts; only a foreign fault fails one, through `contain()`.
- Dev fault injection over the dev channel marks any fact invalid.
- Live semantic probes: capabilities declare dev-only probes (value ranges, handle serials); the
  update-day pipeline runs them in a real game before sign-off.
- Three documents, two keys:
  - fact set, per manifest digest, module build and revision, signed with the offline release key
    after sign-off. Header: format, game, module build key, revision, finders commit, manifest
    digest. Entries are `(key hash, payload)` leaves sorted by key under a Merkle root; the
    signature covers the header and the root. Payloads are opaque bytes (a value now, a recipe
    later). Releases sharing a manifest share sets.
  - overrides (force features or capabilities off), signed with an online server key: a kill switch
    needs no offline key, and the worst a stolen online key does is what withholding already can.
  - session bundle: the entitled entries with their Merkle proofs plus the overrides, bound to the
    session and encrypted with a key from the lease. Watermarking belongs here, never in values.
- A compromised server can withhold facts, never forge one: values are trusted only through the
  offline key.
- Delivery:
  - the loader sends the module build keys; per module build the server picks the latest enabled
    revision for the release's manifest and drops entries the session isn't entitled to;
  - a module with no set is "not yet supported" and its capabilities are unavailable; the server
    refuses the session only when a `core` capability is uncovered;
  - the bundle rides in `boot_info`; revisions and newly entitled entries arrive over the session
    and apply at a safe point.
- No client cache in release: no server, no start. Dev reads local bundles signed with the dev key,
  which release builds reject.
- The container format lives in `contracts/`: little-endian, canonical, versioned, with golden
  vectors that the C++ decoder, the generator's encoder and the TS server all test against.
  - A format change adds a version, never mutates one. A module declares the formats it reads; the
    server keeps an encoder for every format a live release uses.
- Only the latest build matters. The binaries cache, outside git and keyed by module build, holds
  each module's latest build and the one before it (for checking a new finder isn't overfit);
  reports compare against the last published set, not old binaries.
- New builds come from snapshots of the installed game; later, SteamCMD fetches them headless when
  app 730's `buildid` changes (a one-time login the human sets up).
- The update-day pipeline, as moon tasks: ingest, generate (values, changes against the last
  published set, finder warnings), harvest and probe (both need a running game), then sign-off.
  Agents may run everything before sign-off; signing with the offline key and publishing (disabled,
  then enabled) are always the human's.
- A broken finder makes its facts fail and its capabilities unavailable. A partial set may be
  published when no `core` capability is affected; the finder fix lands as the next revision.
- Metrics: update-day latency per module and per step; load failures reported from the field.
- Seams for the protection work (designed in "Server inputs" and "Protection toolchain"):
  - every read of a fact value goes through one kit accessor, so storage can become encoded later
    by changing one function (and decoding stays about a load and an XOR);
  - a payload carries a tag: a literal now, a recipe later, evaluated by one resolve function, and
    validated on what it yields;
  - key hashes are `H(release seed, name)` from the first release, the seed from the generated
    `lucent::build` header (fixed in dev). Telemetry keys are per release; the server maps them
    back through that release's manifest;
  - a post-link check fails a release build whose image contains any declared fact name.

## Server inputs and licensing integrity

- The lease and game data travel on separate channels.
- Game data keys and types are declared in game code (see Facts).
  - The build exports a manifest, and server tooling validates bundles against it.
  - Only the container schema lives in `contracts/`.
- Bundle shape and delivery: see Facts.
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
- The update-day pipeline: see Facts.
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
- RTTI and exceptions: confirm the `/GR-` decision when the first DLL boundary is built.
