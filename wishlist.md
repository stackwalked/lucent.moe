# Wishlist

Everything discussed so far that isn't built yet. A backlog, not a spec: entries leave as they land.

## Gate and tooling

- luau-lsp analysis, pinned with the first Luau code.
- Complete `.protolock`: moon, cmake, ninja and uv were installed before the lockfile was on, so
  they have no recorded hashes.
- Architecture boundaries enforced by moon constraints and CMake visibility. Nothing depends on
  `research/`. TS has no import-graph check: `platform/server` exports only types (`./rpc-type`),
  so a runtime import from `web` or a connector fails to resolve, the one boundary that would fail
  silently. dependency-cruiser was dropped (18.8.0 can't read TypeScript 7.0); revisit when TS
  packages import each other at runtime.
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
- `lucent_module()` and `lucent_executable()` join `lucent_library()`/`lucent_test()` with their first
  users. A lint bans raw `add_library`, `add_executable` and `target_compile_options` outside
  `native/cmake/`.
- vcpkg overlay ports instead of vendored source, once a port needs patching.
- Verify luau and tracy build under clang-cl with `/GR-` (Catch2 3.16.1, safetyhook 0.7.0 and
  zydis 4.1.1 do).
- Debug info: PDBs archived per release, never shipped.
- Release hygiene: `/Brepro`, `-ffile-prefix-map`, `/pdbaltpath`, ThinLTO.

## C++ dialect

Decided in full. Landed in `native/.clang-format`, `native/.clang-tidy`, `native/cmake/lucent.cmake`,
`native/core/src/toolchain_probe.cpp`, `tools/lint/ast-grep/`, `tools/lint/suppressions.py`, and
`native/AGENTS.md` for what no tool checks. Still to land, each with the first code it applies to:

- core: `flags<E>`, `fixed_string`, and the generated `lucent::build::*` header.
- `provenance.py` (a uv script, with the first `foreign/`).
- `-Wunsafe-buffer-usage` off by path in the foreign-memory layer; `misc-no-recursion` off by path in
  tools and tests once something there recurses.
- Lab C++ config sharing (clang-format and clang-tidy only search parents), with the first lab C++
  project; likely generated copies with a freshness check.
- Reopen generic code (`describe()`, enum introspection) when clang ships reflection; preconditions
  move to `pre(...)` when it ships contracts.

## Kit

- `boot_info` grows (v2 carries the session ends, the image kind and the mapper's trampolines):
  - host and build ids;
  - the lease blob and the game-data blob.
- A release boot path: dev starts the module through its `lucent_boot` export after either loader;
  release needs its own way in.
- No static TLS in mapped modules: `lucent_module()` fails the build on a TLS directory, ast-grep bans
  `thread_local`/`__declspec(thread)`, and our code bans function-local statics. A dependency that
  needs TLS is a decision: build it with `/Zc:threadSafeInit-`, keep it out of the module, or implement
  TLS through ntdll internals with a check per Windows build.
- Lifecycle: a resolve stage between boot and attach (boot → attach → run → detach → unload exists).
  - Safe points.
  - In-flight hook counting.
  - Unhooking only once no hook call is in progress.
- Hook manager (inline hooks, all-or-nothing install, in-flight counts, and removal proven idle
  with every other thread frozen landed):
  - kit worker threads join before hook removal; until then removal counts them as busy;
  - `hook_object`: shadow vtables, only on objects that live as long as the module; removal restores
    the vtable pointer only if it's still ours (read under `contain()`) and frees the copy once
    drained. No patching of slots in the real vtable: it misses devirtualized and direct calls;
  - hook requests from facts, with the slot's signature checked against the fact's, and install
    checking `vtable[slot] == method` when both are facts;
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
- Overlay rendering is our own, not Dear ImGui: a highly custom look would mean patching its backend
  and rewriting its widgets. Libraries, in dependency order:
  - `libs/render/ui`: input snapshot, layout, widgets, interaction, animation, theme tokens. No GPU.
  - `libs/render/menu`: menu pages from the settings' `describe()`.
  - The target glues it together (Present hook, snapshot, ui, backend). A backend draws into the
    device and target it's handed and knows no hooks, so the same stack runs in a standalone window.
- Text landed in `libs/render/text` (DirectWrite). Still to land with it:
  - one atlas patch type in `draw` for `text::atlas_patch` and `d3d11::atlas_upload`, which match
    field for field;
  - `draw_list` exposing `pixels_per_unit`, so drawing a layout on a list of another scale is
    refused;
  - a COLR test on a fixture font with colour layers (only probed against Segoe UI Emoji so far).
- Around the D3D11 backend (`libs/render/backends/d3d11` has landed):
  - HDR targets (scRGB, HDR10) draw in linear scRGB at a fixed paper white, built when first seen;
    until then the backend refuses them;
  - the glue builds the renderer on a kit worker unless the device is single-threaded, and keeps
    the overlay off until it is ready;
  - the glue makes the target view from the back buffer each frame and releases it before
    `Present` returns (no back buffer is held between frames, so resizes need no hook);
  - a new device (video settings, device removed) means a full rebuild: atlas pages re-upload from
    the text system's CPU copy, images re-create lazily from their owners' caches;
  - render runs inside `contain()`, and a fault turns the overlay off;
  - dev-only stats over the dev channel: GPU time from a timestamp ring, CPU record and submit time,
    draw calls, records, passes, atlas evictions, stale-handle misses;
  - the glue draws only on the swapchain whose `OutputWindow` is the game's main window; whether to
    hook `Present1` too is a per-game call.
- Layout and widgets:
  - each frame code declares a tree of elements (boxes with layout properties; text, icon and
    custom-draw leaves); layout runs (widths bottom-up as fixed, fit, grow or percent with min and
    max, text wrapped at final width, then heights and positions); then the tree records draw
    lists. Measuring and drawing come from one declaration. Children are given as lambdas
    (`function_ref`), so a scope can't be left open;
  - layout: row or column, padding, gap, main and cross alignment, wrapping text with ellipsis,
    absolute and anchored placement; flex-wrap of boxes when needed;
  - IDs from a stack (parent plus local key); literal keys hashed `consteval`; settings rows key on
    the setting's path, lists on their items. Per-ID state (animation, scroll, edit buffers) lives
    in the frame's context, dropped after a few unseen frames. Hit-testing during declaration uses
    each ID's rect from the previous frame, so hover is only stale in a frame where layout moves;
  - windows, popups and tooltips are roots in a z-ordered stack; input goes to the topmost root
    under the cursor; Escape closes the top popup; popups anchor to an element by ID and nest;
  - scroll containers clip, scroll smoothly, have a draggable rail, and take the wheel when topmost
    under the cursor;
  - text fields, single and multi-line: mouse caret, selection, word jumps, clipboard through a
    glue-provided interface, undo. The input snapshot carries IME composition events; the glue
    feeds them from `WM_IME_*` when the first field needs it;
  - focus is an ID; tab order is declaration order; arrows in lists, Enter or Space activates;
  - the glue's window-procedure subclass builds one input snapshot per frame (cursor, buttons with
    click counts, wheel, keys pressed, released and repeated, UTF-8 text, modifiers, the injected
    clock); the UI reports whether it wants the mouse and keyboard, and the glue keeps those from
    the game. Given snapshots, the UI is deterministic and tested without a GPU;
  - the UI edits settings through the settings store, never feature state; changes reach the game
    thread at a safe point;
  - the menu is generated from settings' `describe()`; hand-written UI is for HUD windows and
    bespoke pages.
- Theme and animation:
  - `derive_theme(inputs) -> theme` is pure, rerun only when an input changes (accent, preset,
    scale, reduced motion, sampled backdrop light), and its result published. Tokens: colour roles
    (surface, raised, ink, muted ink, accent, danger, focus), spacing and radius scales, type roles
    (body, caption, title, numeric), elevation, two materials, motion. Widgets read tokens, never
    literals (a review rule; a lint would guess);
  - glass (blur, tint, grain, rim, scene-adaptive ink) for the menu; plate (solid, shadow, no pass)
    for HUD windows, since glass over a bright scene reads as a mid-tone slab. Presets are token
    sets;
  - motion primitives on the input snapshot's clock (delta clamped), state per ID: approach
    (exponential), spring (critically damped, velocity-preserving, fixed substeps), tween (duration
    and easing), presence (0 to 1 on enter, back on exit, the caller declaring until it reaches 0);
  - reduced motion zeroes every duration and snaps every spring;
  - animated reflow waits until something needs it.
- Rendering tests, aimed at failures that would be silent:
  - `text`: the atlas allocator and eviction as a pure component; layout against a fixture font
    (fast path and `IDWriteTextLayout` agree on Latin advances, fallback, wrap, ellipsis, bidi
    order). Never a system font: their metrics change between Windows builds;
  - `ui` and `menu` from input snapshots: layout rects, clicks, tab order, popup stacking, wheel
    routing, text-field edits, animation on a test clock, reduced motion; every setting kind maps
    to a control and search finds rows. Rects and state, not draw records;
  - text joins the backend's WARP goldens once it lands;
  - `tools/menu-shot` (the real menu and HUD to PNG by page, scale and theme), micro-benchmarks and
    the dev frame stats inform but don't gate; a libFuzzer target for `frame_data` checking joins
    the parser fuzzing;
  - fixtures (test font, goldens) live in each library's `tests/fixtures/`. Product fonts live in
    git too, where they're first used.
- Rendering is decided in full.
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
- Names for `error_code` and `stage` live in the loader; they belong beside their types.
- Extraction candidate: "one owner by precedence" (command stages, scene restyle, movement goals), once the third copy exists.
- Split the `domains` object by phase when it grows.

## Facts

Foreign knowledge (RVAs, vtable slots, field and schema offsets, constants): declared, derived and
delivered. Decided in full.

Landed in kit (`fact.hpp`, `fact_resolve.hpp`): the fact section, the six typed kinds, one value
accessor, resolve with every per-kind load check, and capabilities. Landed for the bundle:
`libs/crypto` (Monocypher 4.0.2 through an overlay port in `native/cmake/ports`: vcpkg has none;
standard Ed25519, BLAKE2b-256), `libs/bundle` (the format, RFC 6962 Merkle with multiproofs,
canonical decoding, verification) and its golden vectors in `contracts/fact-bundle/v1`. Landed for
delivery: `tools/devkey`, kit's `fact_apply.hpp` and `boot_info` v3, `loader-dev --bundle`.

Still to land, in order:

- the generator and cs2 finders on `libs/probe`; a late-loaded module resolving when it appears;
  the facts log line kept out of release strings; TimeDateStamp read by `pe::image_view`, not kit;
- the first real facts end to end;
- the read-only section between safe points, the per-release key seed, `core` capabilities
  refusing the start;
- release key handling: a release guard that refuses a build whose trusted keys differ from the
  production list, and a post-link check that no release image holds the dev public key.

- Declarations are C++ in the target's foreign layer, by subsystem, and ship. A `consteval`
  constructor hashes the name, which never reaches the binary; ast-grep checks it matches the
  identifier.
- Finders are C++ in a tooling-only library per target (`targets/<game>/finders/`), linked only by
  the generator; moon layering and the release presets keep it out of the module. A finder refers
  to its fact by symbol and carries the `build:`/`found:`/`breaks:` provenance.
- The generator reuses `libs/pe` and `libs/probe`: one PE stack.
- Finders work on decoded instructions (Zydis), never on bytes by default:
  - anchors: export, RTTI vtable (any sub-object), string referrers, another fact, byte patterns
    last;
  - navigation: follow a call/jmp/RIP-relative operand, nth call, callees, callers, function
    containing, vtable slot, `slot_of`, `slots_where(vtable, predicate)`;
  - extraction: displacement, immediate, target, slot index; named captures for several values;
  - instruction patterns parsed `consteval`: register wildcards, pattern variables binding a
    register across steps, operand alternation, steps in either order, sequences that cross
    `.pdata` chunk splits, parameters for computed immediates, the disassembler's register names;
  - predicates and sets: `where`, `one`, intersections, consensus over many sites.
- Every finder yields exactly one distinct value or fails (none, ambiguous). A fact may have several
  finders: at least one resolves, all that resolve agree, otherwise it fails; a finder that fails
  while the rest agree is a warning. Facts depending on facts are ordered; a cycle is an error.
- Strong finders rest on semantic anchors (strings, RTTI, exports, ABI registers, data flow) or on
  consensus over many sites. A finder matching only a function's body shape is weak and needs a
  second, independent finder.
- Every foreign number has a finder: a value witnessed in an instruction that uses it, or, failing
  that, `pinned(value)`, valid only on the module build it was confirmed on. The access API takes
  only facts, so a raw offset needs the counted `raw` escape hatch.
- `libs/probe` indexes RIP-relative references, call targets and immediate operands per module
  build, cached in the binaries cache.
- Source 2 helpers live in `engines/source2/probe`, e.g. `token(name)`, the string-token hash, so
  token constants are names, not numbers.
- A slot's bound is the run of code pointers from its vtable up to the first non-code qword or the
  next RTTI locator (a locator alone overshoots).
- Finder primitives are tested against fixture DLLs we compile. The generator reports each fact's
  value, the finders that agreed, and the change from the last published set.
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
  - The spike held (kit `fact.hpp`, `fact_section.cpp`): a header fact included by two units folds
    to one object; `.lfact$a/$m/$z` merge into one `.lfact` section with no gaps between
    24-byte records, on a page of its own; a mapped module enumerates and writes it. Fact objects
    are `const` with only the value `mutable`, so they need no suppression per declaration.
- Features never name facts. The foreign layer groups facts into capabilities beside them; a
  capability is available when all its facts passed their checks. Reads inside a running feature
  don't re-check facts.
- Domains turn capabilities into what features use: views (plain values for this tick) and stage
  tokens (what a stage may change). Each view and stage type names its `backing` capability.
- A feature declares `needs` (required) and `wants` (optional) as types; `kit::context<F>` is built
  from them, so using anything undeclared fails to compile. A feature is unavailable when a `needs`
  type's capability is; a `wants` part is reached through `maybe<T>()` and degrades alone.
- Requirements are checked at compile time, which replaces the dev-time audit: features through
  their context; domain builders through capability-typed `read_access<capability>`, which only
  accepts that capability's facts.
- Features never write foreign memory. They record intents on stage tokens or propose values; each
  domain applies them once per tick with `write_access`, under one conflict rule it states. Features
  become views, settings and their own state in, intents out, and are tested without a game.
- The context carries the views, stage tokens, settings snapshot, input and the domain clock's
  tick. `draw_context` (render thread, snapshots) has no stages at all.
- A domain may call back into a feature (movement's `on_retime` re-plans a goal over the combined
  tick), with a fresh context, inside the same `contain()`; the registry dispatches declared
  callbacks.
- Features never depend on features; domains depend on domains in a fixed order per tick (world,
  then movement, then command apply), written down where each domain is declared.
- Sketched against old lucent's movement system: goals as features, the arbiter, lookahead and a
  pure simulator as the movement domain, which owns the movement stage and is the command domain's
  only writer of subtick steps.
- Every fact reaches the module from a bundle (in dev, a local one signed with the dev key).
  Derivation happens only in the generator.
- Facts cover game modules only. OS and driver interfaces (DXGI, D3D) are reached through their
  public APIs at runtime; a throwaway swap chain's vtable isn't foreign knowledge.
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
- Seams for the protection work (designed in `wishlist/protection.md`):
  - every read of a fact value goes through one kit accessor, so storage can become encoded later
    by changing one function (and decoding stays about a load and an XOR);
  - a payload carries a tag: a literal now, a recipe later, evaluated by one resolve function, and
    validated on what it yields;
  - key hashes are `H(release seed, name)` from the first release, the seed from the generated
    `lucent::build` header (fixed in dev). Telemetry keys are per release; the server maps them
    back through that release's manifest;
  - a post-link check fails a release build whose image contains any declared fact name.

## Protection

Integrity, licensing, strings and diagnostics, the virtualizer, obfuscation and operations
live in `wishlist/protection.md`.

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
- GitHub issues for deferred items (origin: github.com/stackwalked/lucent.moe).

## Web and platform

- Ownership by root:
  - `platform/`: PostgreSQL schema and migrations, authority and credentials, licensing and native
    `/v1` channels, releases, fact-set storage and session bundle assembly, integrity and risk
    scoring, cloud sync, community and support state, `connectors/discord`, and a narrow offline
    operator entry point (`bootstrap-superadmin`, `transfer-superadmin`, `publish-release`,
    `publish-loader`, `publish-fact-set`, `replay-removals`). Zero HTML, CSS or UI copy.
  - `web/`: every browser HTML surface under one design system (public door, waitlist, all auth
    and handoff flows, member area, admin area including online fact-revision toggles and override
    kill switches). Replaces the old service's handwritten `pages.ts` and `den gen auth-tokens`.
  - `contracts/`: cross-runtime wire and binary container schemas and golden vectors only.
  - `products/`: checked-in product catalog (`products/<id>.toml`: `id`, `kind`, ordered release
    `channels`, default device/slot policy), read by `platform/`, `web/` and build tooling.
- Scope changes from old `lucent`:
  - Invite and waitlist admission with manual licenses only; no cohorts, no billing or checkout.
  - No repo-wide `den` CLI; no `@anthropic-ai/sdk` agent in `connectors/discord`.
  - Fact sets stay signed by the offline release key (`Facts`); `web/` admin handles online revision
    enable/disable and online-key overrides with passkey step-up.
  - Reviewed `.lpkg` extension packages, `/sdk/v1` and WebSocket `Rooms` wait past the initial five
    slices until the value-only Luau script host settles; cloud sync still carries `.luau` scripts
    and `resources` serves admin-curated files.
- Vertical slices (directories appear only with their slice):
  1. authority, credentials, sessions and `web/` shell + admin people/audit;
  2. PC enrollment, native `/v1` reservations/grants/leases and module/loader releases;
  3. fact sets, session bundles, live revisions and integrity/risk scoring;
  4. cloud sync, crash reports, tickets/appeals, review queue + DB-IP geo, waitlist and resources;
  5. profiles, avatar codec, comments, shouts, inbox + SSE presence/events, guides and
     `connectors/discord`.
- Process and origin topology:
  - Two public origins behind Caddy: `lucent.moe` for all browser traffic (`__Host-lucent` cookie,
    WebAuthn RP ID, inline passkey step-up) and `api.lucent.moe` strictly for native `/v1`
    (no cookies, no CORS, no HTML). `auth.lucent.moe` is dropped.
  - Three isolated processes: `platform-server`, `web` and `connector-discord`.
  - `platform-server` is the sole owner of PostgreSQL, `EpochGuard`, `LISTEN`/presence, periodic
    jobs and signing keys (`LEASE_SIGNING_KEY`, `OVERRIDE_SIGNING_KEY`). It runs a public native
    listener on a dedicated DB pool (no statement timeout) and an internal listener (Unix socket in
    prod, loopback in dev) on a separate capped/timed-out browser DB pool.
  - `web` and `connector-discord` hold zero DB credentials and zero signing keys, calling
    `platform-server`'s internal listener with scoped per-peer capability keys.
- Runtime, HTTP/RPC and web stack:
  - `bun@1.4.4` across `platform-server`, `web`, `connector-discord`, tests and workspaces.
  - `platform-server`: `hono@4.13.19` + `@hono/standard-validator@0.4.1` on `Bun.serve` (`:4001`
    and `{ unix }`) for native `/v1/*` and the three streaming routes (uploads, downloads, SSE);
    structured internal IPC (`web` and `connector-discord` → `platform-server`) uses a ~60-line
    `Result`-native procedure map in `core/rpc.ts` over `POST /internal/*/rpc` with zero codegen and
    zero exceptions. Wrapped by a streaming byte-capped body reader (`16 KiB` default → `413` before
    buffering), prefix auth before route matching, and `503` (never `500`) fallback.
  - Validation: `zod@4.6.7` everywhere (`z.strictObject` at external boundaries).
  - `web/`: see "Web design" below.
- Web design, settled topic by topic (T1–T14):
  - Users and boundary: invite-only, hundreds of people. Web holds no authority (no DB, no keys;
    `can()` only steers UI); a compromised web can't act as anyone without their session token,
    and staff actions need a passkey step-up it can't forge. One browser origin, zero third-party
    requests, no state across requests (one exception: per-IP throttle buckets), no UI copy in
    platform. Server-rendered and JS-required (no no-JS path); evergreen browsers only; English
    only, without i18n machinery.
  - Runtime: TanStack Start + Vite, React 19 + React Compiler, no RSC. Served by our own
    `web/src/server.ts` on `Bun.serve` (Unix socket in prod, Vite dev on `http://localhost:4710`),
    no Nitro: `/assets/*` from `dist/client`, the rest to Start's `fetch` handler. Config:
    `LUCENT_WEB_LISTEN`, `LUCENT_PLATFORM_INTERNAL_URL`, `LUCENT_WEB_INTERNAL_KEY`,
    `LUCENT_PUBLIC_ORIGIN`.
  - Contract: `platform/packages/rpc/src/web.ts` holds each procedure's input/output/error
    schemas and the session it needs (`none`/`member`/`setup`/both); the server binds handlers
    with a typed `implement`. Own strict WebAuthn L3 JSON schemas. Names `<area>.<noun…>.<verb>`
    (`signIn.*`, `session.*`, `setup.*`, `credentials.*`, `stepUp.*`, `admin.*`). Session token in
    a `Lucent-Session` header; client IP and user agent in `Lucent-Client` (trusted from web only);
    request id in `Lucent-Request`. Skew rule: platform deploys first, changes stay compatible for
    one deploy, removals take two.
  - Sessions: `__Host-lucent` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Max-Age` = session).
    Member sessions last 7 days (fixed, never slide), setup sessions 30 minutes. Unsigned
    `__Host-lucent-flow` (10 minutes) holds flow tokens and `returnTo`; no token ever reaches
    JavaScript. `session.resolve` returns the viewer (with `can()` standing); session list with
    `public_id`, client info and `last_seen_at` (written at most every 5 minutes). CSRF: `Lax` plus
    an Origin/`Sec-Fetch-Site` gate on every non-GET in the entry; GET never mutates.
  - Auth flows: one sign-in form with conditional passkey autofill and a passkey button;
    passkey-first second factor when the account has one; `GET /setup/<token>` stores the token
    and 303s to `/setup`, redeem is a POST, links stay single-use; re-auth is the step-up dialog
    for passkey holders, a fresh sign-in otherwise; step-up retries the action with the same
    `operationId`. `uqr` renders TOTP QR codes server-side.
  - Routes: pathless `_public`/`_auth`/`_member`/`_admin`/`_dev` layouts; `/admin/accounts`,
    `/admin/accounts/$accountId`, `/admin/roles`, `/admin/audit`; non-staff get 404 on `/admin`.
    No query strings on member and auth pages; admin lists take one `?q=` with `key:value` tokens;
    sort and cursor in `history.state`; lowercase, no trailing slash, 303/308 only. `returnTo` must
    be one leading `/`, same origin, a known non-auth route. Confirm dialogs are component state
    (no route-masked twins).
  - Data: router loaders only (no TanStack Query), authority data never fresh, intent preload
    valid 10s, `invalidate()` after mutations, refetch on focus after 60s. POST server functions
    return results through React 19 form actions; one `operationId` per form instance; no
    optimistic updates; one server-only `callPlatform` gateway handles `SESSION_INVALID`,
    `NOT_FOUND` and `SERVICE_UNAVAILABLE`. Keyset pages of 50, no totals on growing lists.
  - Design system: layers `reset, tokens, base, layout, components, features, overrides`; module
    CSS uses semantic tokens only (lint); tokens written in TypeScript, emitted as CSS by a Vite
    plugin, contrast-tested (WCAG 2.2 AA; `ink-3` inert only). Old lucent's palette: Graphite and
    Washi themes, pink (yours, current, needs you) and shu (stopped, danger), no other hues;
    `lucent-theme` cookie, else the system. IBM Plex Sans 400/500, Geist Mono (trial), Lucide
    icons vendored as one sprite. One shell (admin side nav inside it, auth pages a bare card);
    widths 1600 / 1040 / 480; fixed page anatomy (trail, one `h1` with verbs, captioned sections);
    components re-implemented with old lucent's CSS as visual reference only.
  - Copy: minimal, no filler or AI phrasing, all lowercase (rules and glossary in `web/AGENTS.md`). Uncontrolled
    forms, native constraints with our own messages, shared validation constants from `core`;
    every contract error code has compiler-checked copy; a support reference only on unexpected
    failures. Times as "18 nov 2026, 14:05" in the viewer's zone (`lucent-tz` cookie).
  - Admin (slice 1): accounts list and detail (sign-in summary, roles with expiry, recent audit,
    suspend with reason, reinstate, rename, recover with typed confirmation), add account showing
    the setup link once, role editor without channel grants, no role deletion, audit with typed
    operation labels. Hidden, not disabled, when `can()` says no; step-up checked before submit.
  - Hardening: nonce CSP with `'strict-dynamic'`, no inline styles (`style` prop banned), Trusted
    Types report-only then enforced, `dangerouslySetInnerHTML` banned, `no-referrer`, HSTS
    preload, COOP/CORP same-origin, Permissions-Policy off except WebAuthn, 421 on a wrong `Host`.
    Per-IP buckets: `signIn.*` 10/min, `setup.redeem` 5/min, `stepUp.*` 10/min, 300/min overall.
  - Failure: public pages never need platform; 503/500/404 pages with layout boundaries; reads
    retried once after 250ms, mutations never automatically; `POST /_report` for CSP and browser
    errors; one JSONL line per request (with account id, no PII); `/_health` on the socket only;
    10s SIGTERM drain.
  - Testing: unit tests on `returnTo`, `?q=` parsing, cookies, the entry's gates, throttles,
    `loggablePath` and contrast; HTTP-level integration tests against a real platform (shared
    harness in `platform/packages/testing`); no browser E2E, a manual list per slice instead.
    `routeTree.gen.ts` gitignored and generated by `web:routes`; `.config/dev.env` feeds both dev
    tasks; `/dev/kit` 404s outside dev.
  - Delivery: ≤150 KB gzipped JS per first load (build fails over it), route-split chunks, Plex
    preloaded with metric-matched fallbacks, no streaming in slice 1, immutable hashed assets,
    Caddy compresses, no service worker, only `/` and `/legal/*` indexable, source maps kept but
    never served.
- TS toolchain, dialect and Slice 1A authority core landed in `.biome.jsonc`,
  `.config/tsconfig.base.json`, `tools/lint/ts_hygiene.py`,
  `tools/lint/ast-grep/rules/ts-*.yml`, `tools/proto/postgresql.toml`, `products/*.toml`,
  `platform/AGENTS.md`, `platform/server/migrations/0001_authority.sql`, and
  `platform/server/src/{core,db,products,authority,internal}`. Exact package pins in this section
  are provisional until their slice starts and checks them (TypeScript 7.0.2 was pinned before
  any tool needing its API was tried). Still to land:
  - `contracts/*` and `platform/connectors/discord` (`discord`) as their slices arrive;
  - `platform/packages/testing` (the cluster harness and software authenticator), with web's
    HTTP-level integration tests, its second consumer. `core`, `rpc`, `policy` and `catalog`
    landed in `platform/packages/` (`core`'s moon id is `platform-core`: native has `core`);
  - the native `/v1` listener and periodic jobs, in the slice that gives them routes and work
    (boot, the internal listener, `ops.ts` and `server:dev`/`server:seed` landed);
  - `web/` landed on the slice 1B pins (in `web/package.json`) without Nitro: Start's build
    exports `{ fetch }`, which `web/src/main.ts` serves from `Bun.serve`, and the entry hands
    each request's CSP nonce to the router through `fetch(request, { context })`. Found on the
    way: the server-fn input method is `.validator` (not `.inputValidator`), and server
    functions demand `Origin` + `Sec-Fetch-Site` and seroval-encoded bodies;
  - optional plan templates and `connector_discord_rule` tables when their consumers land.
- Auth, credentials, sessions and authority:
  - No `better-auth`: old lucent spent too long fighting it, and its model has no room for the
    native DPoP flow. Browser credentials and sessions landed in `platform/server/src/auth/` with
    migration `0002_credentials.sql`. Still to land with them:
    - the breach denylist for new passwords (only the 12–128 character rule is checked so far);
    - a periodic job deleting expired sessions, flows and setup links (queries already ignore
      them);
    - the `"appeal"` session purpose (30m, minted only after full 2FA on a suspended account), with
      `/appeal`;
    - `jose@6.2.17` for client P-256 DPoP proofs, with the native loader's sign-in. (Web's
      per-IP sign-in throttles landed in its gateway; its browser WebAuthn uses the platform's own
      JSON helpers, so `@simplewebauthn/browser` isn't needed.)
  - Native loader sign-in uses pushed auth requests (`POST /v1/auth/requests` → clean
    `lucent.moe/auth/device/lauth_...` URL) + loopback `127.0.0.1:<port>/callback` PKCE + DPoP →
    30-day rotating refresh token (30s retry grace) + 5m DPoP-bound access token.
  - Entity model and `can()` access control (hybrid config, multi-product from day one):
    - Closed union of `Action` permissions in code (`"tickets:reply"`, `"accounts:suspend"`, ...),
      with per-action `{ stepUp, audit }` metadata; zero `if (role === ...)` checks anywhere.
    - Pure `can(subject, action, target?)` shared by `platform` and `web` (including integer `rank`
      precedence `subject.maxRank > target.maxRank`); transactional `authorize(txNow, caller,
      action, target?)` enforces `can()` + 30m passkey step-up under `FOR UPDATE`. In `web`, `can()`
      only decides what the UI shows; only `platform` authorizes.
    - Writers take the caller's account id (plus session facts such as `stepUpAt`), never a
      `Subject`: inside the transaction they lock the caller and any target account in ascending id
      order and read status, lock, root and unexpired roles there, so a caller suspended a moment
      ago is refused.
    - Rules the slice 1A review showed `can()` needs (landed): a role's permissions must be a subset
      of its author's (root exempt), also when assigning it; changing a role requires outranking
      both its old and new rank; no action targets the caller's own account (none is
      self-service); no caller, root included, targets the root account; stored permissions that
      are no longer Actions grant nothing and are reported, never a crash.
    - The database keeps root permanent (`account_root_permanent` trigger); `ops
      transfer-superadmin` relaxes it when it lands.
    - Roles, optional plan templates and Discord sync predicates live in PostgreSQL (seeded from
      declarative config, editable live in `web` admin with step-up + audit); bootstrap `root` sits
      at max `rank` (transferred only via `ops transfer-superadmin`).
    - `Device` binds to `Account` (enroll PC P-256 key once per account; default `maxDevices = 1`,
      7d self-service replacement window); `Entitlement` covers 1..N products (`EntitlementProduct`:
      `productId`, `features: "*" | FeatureTag[]`, `channels`), unioned at `txNow`; `ProductSlot`
      serializes active sessions per `(accountId, productId)`. `device`, `device_change_window`
      and `product_slot` arrive with slice 2, which first uses them.
    - Permanent confusable-checked `username_claim`: the fold table is every Unicode
      `confusables.txt` 18.0.0 entry whose source is an ASCII letter, digit or underscore, after
      case folding (0→o, 1→l, i→l, m→rn, `_` dropped); single-use 7-day account-only invites (no
      cohorts) with inviter strike attribution; non-admin timing-padded email reset setting
      `reset_lock`.
- Native contracts, lease channel and bundle pipeline:
  - `contracts/` holds canonical little-endian versioned binary container definitions, `/v1` wire
    Zod schemas, and committed golden `.bin`/`.json` vectors verified by both `ctest` and
    `bun test`. Zero codegen until hand-mirroring hurts.
  - Key split: **Ed25519** over raw canonical bytes for server and offline authorities
    (`RELEASE_TRUSTED_KEYS`, `LEASE_SIGNING_KEY`, `OVERRIDE_SIGNING_KEY`), including a fixed-layout
    binary Ed25519 runtime lease (dropping `lucent-lease+jwt` so the mapped module needs no JSON or
    JWS parser); **ECDSA P-256** for client Windows TPM 2.0 / CNG installation and session keys.
  - Separate `/v1` channels: `POST /v1/sessions/:id/lease` (15s cadence / 60s TTL, carries
    `bundle_revision_tag` + measurement regions, never game data) and
    `POST /v1/sessions/:id/bundles` (lazy per-feature and per-module AEAD-encrypted session bundles
    with Merkle proofs + online overrides + per-session watermarks).
  - No immediate `INTEGRITY_REFUSED` oracle on `/handoff` or `/lease`: mismatches feed key-material
    derivation (`measure`/`mix`/`derive`) and append `risk_signal` rows (tagged with `release_seed`)
    for asynchronous risk scoring, review items and delayed decoupled actions.
  - `ops publish-release` / `publish-loader` / `publish-fact-set` verify offline signatures,
    manifest digests, revision monotonicity and `core` coverage; `web` admin toggles enabled state,
    manages online-signed overrides, and tracks update-day latency per `module_build_key`.
- Connectors, jobs and untrusted boundaries:
  - `platform/connectors/discord` (`discord`, Slice 5): outbound-only worker on
    `@discordjs/core@2.6.0` + `@discordjs/rest@2.6.3` + `@discordjs/ws@2.0.4`, calling
    `platform-server` strictly via `discordRpc` (zero authority writes, no emails/IPs/PC IDs). Role
    sync is driven by declarative `connector_discord_rule` rows over one serial queue (15s audit
    cursor feed + hourly reconcile + on-join), alongside `#status`, `#resources`, `#bugs` ↔ GitHub
    Issues `/triage`, and invite-leak deletion.
  - Avatar uploads run `@jsquash/jpeg@1.6.0`, `@jsquash/png@3.1.1` and `@jsquash/webp@1.5.0` in a
    5s-bounded `env: {}` `Bun.spawn` child process with WASM linear memory rewritten to `640 MiB`
    max, stripping metadata and storing 256px/64px WebPs by SHA-256 in Postgres; release binaries
    and `<= 64 MiB` resources stream to `ARTIFACT_DIR`.
  - Plain `fetch` mail adapter (`resend` | `brevo` | `log`, `10s` timeout, outside `Tx`) and offline
    `mmdb-lib@3.0.5` DB-IP Lite reader.
  - Unref'd periodic jobs (`1m` challenges/nonces/receipts/refusals; `10m` retention, risk scoring,
    `.mmdb` reload, 7d idle ticket auto-close) with explicit 30d / 90d / 365d / forever retention
    tiers; closed-field JSONL logger with fail-closed `loggablePath` allowlist, `removed` lines for
    `ops replay-removals`, and `SIGTERM` health-first graceful drain.
- Testing and local dev stack:
  - `bun test` (`tests/<unit>.test.ts`), behavior-sentence names, zero coverage targets, zero
    snapshots, `mock.module` banned by `ast-grep`. Tests cover where failure is silent, expensive or
    subtle (`can`/`authorize` + multi-product unioning, auth/DPoP/TOTP replay, multi-connection
    `FOR UPDATE` races and `statement_timeout`, binary containers + Merkle proofs + golden vectors,
    migration checksums, `withMaxMemory` and `loggablePath`); clocks, RNG and external HTTP adapters
    are injected with no network in `:test`.
  - Real PostgreSQL `18.7.0` pinned via `proto` (`tools/proto/postgresql.toml` →
    `theseus-rs/postgresql-binaries`, no Docker or `pglite`). Test setup runs `postgres -F` under
    `.moon/cache/pg-test/`, migrates `lucent_template` once, and clones per-file databases via
    `CREATE DATABASE ... TEMPLATE`.
  - Cross-runtime contract gate: `contracts:test` (`bun test`) and native `ctest` verify the exact
    same committed `.bin` and `.json` golden vectors.
  - Local dev runs through `moon` (`server:seed`, `server:dev`, `web:dev`) over `.moon/cache/dev/`
    with dev keys rejected by release builds, fixed loopback origins (`http://localhost:4710` for
    WebAuthn, `127.0.0.1:4711`–`4712` for `platform-server`), seed rows written through real server
    writers, and a dev-only `/dev/kit` UI workbench aliased to 404 in production builds.
- `infra/` (created only when deployment lands, added to root `AGENTS.md` then):
  - Holds `compose.yml` (`postgres:18.7` in its own container so backend deploys never restart
    PostgreSQL, plus `platform-server`, `web`, `discord` and `caddy` with digest-pinned base images,
    read-only rootfs, dropped capabilities, and `0750` socket volumes for `/var/run/postgresql` and
    `/run/lucent`), `images/*.Containerfile` sharing one `BUN_IMAGE` digest pin, `caddy/`
    (`Caddyfile`, `lucent.caddy` and redacted access-log audit), and `ops/` (`backup.sh`,
    `restore.sh`, `provision.sh`, `env.example`).
  - CI stays in `.github/workflows`, toolchains in `.prototools`/`tools/proto/`, and migrations and
    DB operator verbs in `platform/server/`.

## osu (Tamaki)

Tamaki (github.com/gorelace/tamaki: a standalone exe reading osu! from outside, SendInput, its own
DX11 overlay window; lazer and stable) is rewritten here as a second product.

- Decided (names still open: the osu target, the two halves of the kit split):
  - one product format (a module plus fact bundles) with two placements: mapped into the game
    (cs2), or into a `lucent-host` process the loader spawns per product (osu: remote reads, an
    overlay window, an input domain); same lease, session, lifecycle and protection;
  - a memory source under `read_access` (local under `contain()`, remote through a process handle,
    fixture bytes in tests), so domains and features don't change between placements;
  - `foreign_ptr32<T>` for 32-bit stable, read by the x64 host;
  - `kit` split by placement: facts, registry, context, settings and session shared; hooks and
    in-game Present injected-only; attach loop, remote reads, overlay window and input injection
    host-only;
  - two domain loops: play state at the game's rate, input at about 1 kHz (aim proposes cursor
    corrections, relax and tap propose key events, the input domain applies them once per pump).
- .NET facts come from a layout harvest: `tools/dotnet-layout` (C#) loads the target's assemblies
  in a worker on the target's own runtime and reads the layouts back with ClrMD, as Tamaki's dumper
  does; the generator takes the harvest as an input. The .NET SDK is pinned through proto with a
  TOML plugin vendored into `tools/proto` (the registry's community plugin as a starting point),
  landing with the first C# code.
- `engines/dotnet/`: the probe half (metadata, an IL decoder for stable's obfuscated assembly,
  managed finders `dotnet::field`, `type_token`, `static_field`) and the shipped half (navigating
  the CLR's runtime structures to roots; no heap or pattern scans in release).
- A managed fact set is keyed by every module that shapes it: the assembly, its base assemblies,
  the runtime.
- Stable is feature-locked: its finders (IL patterns, `clr.dll` navigation) are written once. JIT
  code addresses still differ per run, so no stable fact is a code address.
- `coreclr.dll` 10 exports `DotNetRuntimeContractDescriptor`, and lazer ships on 10. It
  describes the path from the runtime's roots to a type's statics, but not `FieldDesc`: field
  offsets still come from the harvest (`research/kb/dotnet/contract-descriptor.md`).
- A live probe in dev (Tamaki's `ChainCheck`) walks every chain in a running game with the
  candidate facts before sign-off.
- Out of scope: anything around osu!'s own client authentication.
- Order, after the facts machinery: memory source and kit split; `engines/dotnet` and lazer's
  foreign layer; host placement; features (relax, tap assist, aim assist, autobot and replay, with
  `humanize` as a library); stable; the `products/` entry.

## Open

- Isolating our allocations from the game's heap.
- A generic "revise" round in an arbiter vs. a planner per domain.
- Script precedence policy (a product decision).
- RTTI and exceptions: confirm the `/GR-` decision when the first DLL boundary is built.
