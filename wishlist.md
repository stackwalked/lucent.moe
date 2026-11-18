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
- Verify luau and tracy build under clang-cl with `/GR-` (Catch2 3.16.1, safetyhook 0.7.0 and
  zydis 4.1.1 do).
- Debug info: PDBs archived per release, never shipped.
- Release hygiene: `/Brepro`, `-ffile-prefix-map`, `/pdbaltpath`, ThinLTO.

## C++ dialect

Decided in full. Landed in `native/.clang-format`, `native/.clang-tidy`, `native/cmake/lucent.cmake`,
`native/core/src/toolchain_probe.cpp`, `tools/lint/ast-grep/`, `tools/lint/suppressions.py`, and
`native/AGENTS.md` for what no tool checks. Still to land, each with the first code it applies to:

- core: a fail-fast `unreachable()`, `flags<E>`, `fixed_string`, and the generated
  `lucent::build::*` header.
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
  - `libs/render/draw`: recording only (draw list to frame data, units and snapping, paths). No
    GPU, no OS; tested headless.
  - `libs/render/text`: fonts, shaping, fallback, rasterization, the glyph atlas, measure and wrap.
    Emits glyph quads into a draw list.
  - `libs/render/backends/d3d11`: consumes frame data; owns GPU resources, layer and blur passes,
    atlas uploads, pipeline state save and restore. Depends on draw only.
  - `libs/render/ui`: input snapshot, layout, widgets, interaction, animation, theme tokens. No GPU.
  - `libs/render/menu`: menu pages from the settings' `describe()`.
  - The target glues it together (Present hook, snapshot, ui, backend). A backend draws into the
    device and target it's handed and knows no hooks, so the same stack runs in a standalone window.
- The draw list:
  - one 64-byte quad record per shape, glyph, icon or image quad (bounds, geometry, paint, atlas
    uv, two colours, kind bits), drawn instanced: the vertex shader builds corners from
    `SV_VertexID` and reads the record from a structured buffer, with no vertex or index buffer.
    Only tessellated paths emit triangles, as their own commands in the same ordered list;
  - glyph and icon pages are slices of one `Texture2DArray`, so they never split a batch; only
    arbitrary images bind their own texture;
  - primitives: rect and rounded rect (radius per corner), circle, arc, segment with caps, Gaussian
    shadow, convex and concave polygons, polylines (width and tint per point), glyph runs, images,
    icons. Fills, and strokes inside closed edges or centred on open paths;
  - paints: solid, linear gradient, noise; paint kind bits leave room for radial and conic, added
    when needed;
  - colour authored in sRGB with straight alpha; the backend premultiplies; blending in the
    target's space;
  - units times a scale per list; axis-aligned edges snap to pixels, strokes of one unit or less
    become whole pixels; translation and uniform scale only;
  - clipping is a stack of scissor rects; a rounded clip is a layer with a mask. `push_layer` takes
    data (backdrop blur, group opacity, mask radius, effects such as rim and light sampling); only
    blur and opacity cost a pass;
  - a draw list is a value with no globals, recorded by one thread at a time; limits are part of
    its type (an invariant when broken); the backend checks frame data once and refuses a bad frame
    whole.
- Text is DirectWrite end to end (an OS DLL: no dependency to vet for TLS), from an isolated
  factory:
  - shaping, bidi, line breaking, and fallback (our chain first, then the system's); our fonts
    registered from bytes through an in-memory loader;
  - hinted grayscale rasterization (`NATURAL_SYMMETRIC`) to A8 on the CPU, four horizontal subpixel
    phases; no ClearType, which can't blend over arbitrary backgrounds;
  - a fast path for strings fully in the primary font that need no shaping (cached advances plus
    kerning pairs), and `IDWriteTextLayout` with a glyph-run-collecting renderer for the rest,
    cached by string, font and width. Both yield one `text_layout` with one measure, wrap, ellipsis
    and draw;
  - the glyph atlas is fixed A8 pages (texture-array slices); entries carry their page's
    generation; when full, the least recently used page not touched this frame is cleared and
    reused. Icon pages are pinned. Rasterization is synchronous with a per-frame budget (an
    over-budget glyph appears a frame later), and the UI's known characters are prewarmed;
  - COLR emoji are stacked tinted glyph quads from the same atlas; bitmap emoji (sbix, CBDT) fall
    back to the outline. Unverified: that Windows 11's Segoe UI Emoji still has COLRv0 layers;
  - the text system lives on the render thread, takes UTF-8, and converts at the DirectWrite
    boundary.
- Shaders:
  - compiled at build time by the SDK's `fxc.exe` (D3D11 needs DXBC) into generated headers of
    `constexpr` bytecode in the build tree; debug info and no optimization in dev, `/O3` with
    reflection and debug info stripped in release. No runtime compiler. fxc's version follows the
    SDK the toolchain picks;
  - every cbuffer and the quad record are defined once in a `.hlsli` shared with C++, using only
    16-byte vector members, with `static_assert`s on sizes and offsets;
  - programs: quad VS (instanced, from `SV_VertexID`), path VS, one main PS branching on the
    record's kind, blur PS (separable Gaussian, bilinear-folded taps), downsample PS, composite PS
    (mask, opacity, rim). SDF antialiasing from screen-space derivatives, erf edges and shadows,
    premultiplied output;
  - colour: authored sRGB; blend in gamma space on UNORM targets; on `_SRGB` targets the shader
    linearizes and the hardware re-encodes; blur in the target's space. HDR targets (scRGB, HDR10)
    draw in linear scRGB at a fixed paper white, built when first seen;
  - no shader hot reload: it would bring back a runtime compiler.
- The D3D11 backend and resource lifetime:
  - `renderer` is built from a device and its immediate context (feature level 11_0), on a worker
    unless the device is single-threaded; states `idle → building → ready | failed`, three tries
    per device, the overlay off until ready;
  - `render(frame, target)` runs on the presenting thread; the target is a view the glue makes
    from the back buffer each frame and releases before `Present` returns (no back buffer is held
    between frames, so resizes need no hook);
  - a new device (video settings, device removed) means a full rebuild: atlas pages re-upload from
    the text system's CPU copy, images re-create lazily from their owners' caches;
  - `image_handle` is a slot plus a serial from one process-wide counter that never restarts, so a
    stale handle never matches; it draws nothing and counts as a miss;
  - one structured buffer for records and one vertex buffer for paths, grown geometrically and
    mapped once per frame; atlas uploads as dirty rects per slice; scratch targets pooled in 64 px
    buckets per format and evicted after 240 unused frames; light readback through a ring that
    never waits;
  - an RAII guard saves and restores the game's whole pipeline state (clearing hull, domain and
    geometry stages while we draw); render runs inside `contain()`, and a fault turns the overlay
    off;
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
  - `draw`, no GPU: snapping, batch boundaries (clip and image split runs, atlas pages don't), path
    tessellation (area preserved, nothing inverted, concave and self-touching inputs), limits;
    `constexpr` parts by `static_assert`;
  - `text`: the atlas allocator and eviction as a pure component; layout against a fixture font
    (fast path and `IDWriteTextLayout` agree on Latin advances, fallback, wrap, ellipsis, bidi
    order). Never a system font: their metrics change between Windows builds;
  - `ui` and `menu` from input snapshots: layout rects, clicks, tab order, popup stacking, wheel
    routing, text-field edits, animation on a test clock, reduced motion; every setting kind maps
    to a control and search finds rows. Rects and state, not draw records;
  - the backend renders `frame_data` on WARP against golden images (at most 3 per channel): shapes,
    paints, shadows, paths, text, layers, atlas pages, on UNORM, `_SRGB`, typeless, BGRA and MSAA
    targets. A moon task regenerates goldens, and a human reviews the diff before they're committed.
    Each golden records its OS build; a mismatch on another build reads as drift;
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
accessor, resolve with every per-kind load check, and capabilities. Still to land, in order: the
bundle (Monocypher through `libs/crypto`, via vcpkg), `libs/probe` with the generator and cs2
finders, the first real facts end to end; then the read-only section between safe points, the
per-release key seed, and `core` capabilities refusing the start.

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
  - `web/`: `@tanstack/react-start@1.169.5` + `vite@8.3.8` (Nitro `bun` preset), `react@19.3.1` +
    `babel-plugin-react-compiler@1.0.0`, CSS Modules with cascade layers, native `<dialog>` and
    `popover` primitives, no UI kit and no Tailwind. Confirm dialog + page twins use nested child
    routes with route masks; markdown and syntax highlighting run in server
    loaders/`createServerFn`.
  - Clean browser URLs: `URLSearchParams` + `stripSearchParams` replaces TanStack Router's default
    JSON search serializer; zero query strings on member and auth pages (`returnTo` in short-lived
    `__Host-lucent-flow` cookie; cursors and sorts in React + `history.state`; RFC `?code=`
    callbacks `303`-redirect immediately); admin lists take at most one human-readable `?q=` when
    non-empty.
- TS toolchain, workspaces and boundaries (landing with Slice 1):
  - Repo-level pins: `bun = "1.4.4"` in `.prototools`; `@biomejs/biome@2.6.8`, `@types/bun@1.4.4`,
    `dependency-cruiser@18.8.0` and `typescript@7.0.2` in root `devDependencies`; exact `x.y.z` or
    `workspace:*` versions enforced everywhere (no `^`/`~`).
  - Root holds only `package.json`, `bun.lock` and `.biome.jsonc`; `.config/` holds
    `tsconfig.base.json` and `depcruise.mjs`; Vite caches go under `.moon/cache/vite/<project>`,
    with no `.tsbuildinfo` files.
  - Flat project roots: `platform/server` (moon id `server`) and `web` (moon id `web`) in Slice 1;
    `contracts/*`, `products/*`, `platform/packages/*` and `platform/connectors/discord` (`discord`)
    appear only with their consumers.
  - Inherited `.moon/tasks/typescript.yml` runs `lint`, `typecheck` and `test`; `repo:boundaries`
    runs `depcruise` across the whole TS graph.
  - `platform/server` exposes only `"./rpc-type": { "types": "./src/internal/app.ts" }`; `depcruise`
    enforces `type-only` imports from `web` and `connectors/*` to that entry, bans circular and
    cross-layer imports inside `platform/server/src/` and `web/src/`, and keeps `contracts/*` and
    `products/*` as pure leaves.
- TS dialect — types, data and banned syntax:
  - Plain imperative code at call sites; no Effect runtime; type-level machinery stays in `core/`
    and `ui/` primitives.
  - Everything is `type` + `function`: plain `readonly` object records with free functions for data,
    and closure factories (`openX`/`createX`) for stateful handles. `class`, `#` private fields,
    `interface`, `enum`/`const enum`, `namespace`, barrel `index.ts`, `export *` and
    `export default` (except `*.config.*`) are banned.
  - Parse at the edge into branded types (`zod` `.brand<Tag>()` or `Brand<T, Tag>`) for all opaque
    IDs, digests and quantities. `EpochMs` (branded integer ms) is the universal timestamp value;
    `Date` and Node `Buffer` are banned outside driver shims (`Uint8Array` everywhere).
  - `null` is domain absence (`T | null`); `undefined` is only for omitted `?:` options
    (`exactOptionalPropertyTypes`) and collection misses. Shorthand `readonly T[]`/`T[]`,
    `ReadonlyMap`/`ReadonlySet` for dynamic keys, no `expr as T` casts outside `core/` and `db/`
    (except `as const`), no `!`, and no `boolean` parameters in our own functions (React `.tsx`
    props exempt).
- TS dialect — errors, effects, async and naming:
  - Three-tier error model: `Result<T, E>` (`ok`/`err`) for expected domain and I/O failures;
    `trySync`/`tryAsync` in `core/contain.ts` around throwing foreign APIs (rethrows
    `InvariantDefect`); `invariant()`/`unreachable()` for our own bugs, caught only at the top-level
    request/job boundary (`503 SERVICE_UNAVAILABLE` + rollback + error log). `ast-grep` bans
    `throw`, `try`/`catch` and `.catch()` outside `core/contain.ts` and `web`'s `route-control.ts`.
  - Ambient globals banned by `ast-grep`: `Date.now()`, `new Date()`, `Temporal.Now`,
    `Math.random()`, `process.env`/`Bun.env` (outside `config.ts`) and `console.*` (outside CLI
    `ops.ts`). At most 3 positional parameters; 4+ take a `readonly` parameter object.
  - Biome `noFloatingPromises` and `useAwait` as errors; every outbound `fetch` or `Bun.spawn`
    requires an `AbortSignal` deadline; never run `Promise.all` over queries sharing one `Tx`.
  - Naming: `camelCase` values/fields, `PascalCase` types/schemas/components, `kebab-case.ts` files
    (`PascalCase.tsx` in `web/src/ui/`), SQL and native `/v1` JSON in `snake_case` mapped once at
    the edge. Booleans start with `is`/`has`/`can`/`should`; pure queries drop `get`; DB reads split
    `findX` (`X | null`) from `readX` (`Result<X, E>`); `utils.ts`/`helpers.ts`/`types.ts` banned.
- TS static enforcement:
  - `.config/tsconfig.base.json`: strict flags plus `erasableSyntaxOnly` and
    `allowImportingTsExtensions`.
  - `.biome.jsonc`: TS/JS plus `**/*.css` (`.module.css` auto-detected; JSON stays `dprint`'s);
    enables `useImportExtensions`, `noBarrelFile`, `noReExportAll`, `noDelete`, `noExplicitAny`,
    `noConsole` (off in `ops.ts`), `useAwait`, `noNonNullAssertion`, `useImportType`,
    `useExportType`, `useConsistentTypeDefinitions` (`type`), `useConsistentArrayType`
    (`shorthand`), `noEnum`, `noNamespace`, `noParameterAssign`, `noParameterProperties`,
    `noDefaultExport` (off in `*.config.*`), and type-aware `noFloatingPromises` and
    `useExhaustiveSwitchCases`.
  - Six `ast-grep` rules (with tests) when Slice 1 lands: `ts-no-class`, `ts-contain-only`,
    `ts-no-type-assertion`, `ts-no-bool-parameter`, `ts-no-get-prefix` and `ts-no-ambient-effects`.
  - `routeTree.gen.ts` carries a generated marker, is skipped by format/lint, marked
    `linguist-generated`, and freshness-checked in `web:check`.
- Data layer:
  - PostgreSQL `18.7` via `pg@8.23.1` (`@types/pg@8.23.1`), wrapped in `platform/server/src/db/`
    with distinct branded `Db` and `Tx` handles, `sql` tagged templates (raw SQL strings banned
    outside `migrate.ts`), Zod row decoders (`InvariantDefect` on mismatch), wire-level OID parsers
    (`timestamptz` → `EpochMs`, `bytea` → `Uint8Array`), and a runtime `inFlight` guard against
    concurrent queries on one `Tx`. No ORM or query builder.
  - `withTx` captures DB `now()` as `txNow: EpochMs`, rolls back on `err(...)` and commits only on
    `ok(...)` (or explicit `errCommit(...)` for security denials that persist failure/audit rows).
  - Canonical lock order: `account` → `device` → `entitlement` → `product_slot` →
    `load`/`runtime_session` → append-only `audit`/`inbox`/`receipt` (never locked); no I/O outside
    Postgres while holding a `Tx`.
  - Forward-only checksummed `migrations/NNNN_name.sql` under `pg_advisory_lock`; `checkSchema` at
    boot exits `2` on mismatch. Prefixed 128-bit random IDs (`acc_...`) for entities and `bigint`
    identity for ordered event/audit streams.
- Auth, credentials, sessions and authority:
  - No `better-auth`. Own the auth tables directly over `@simplewebauthn/server@14.1.0` +
    `@simplewebauthn/browser@14.0.0`, `Bun.password` (`argon2id`, 12–128 chars + breach denylist +
    timing-equalized dummy verify), RFC 6238 TOTP on `crypto.subtle` (`TOTP_ENCRYPTION_KEY`
    AES-256-GCM with `kid` tag, plus `last_used_step` replay guard), and `jose@6.2.17` for client
    P-256 DPoP proofs.
  - One `browser_session` table (`__Host-lucent` 256-bit token stored as SHA-256) with fixed-TTL
    `purpose`: `"member"` (12h, never slides, carries `stepUpAt`), `"setup"` (15m, username + first
    factor only) and `"appeal"` (30m, minted only after full 2FA on a suspended account, `/appeal`
    only). DB `txNow` enforces 5m freshness for credential changes ("never remove the last
    credential" under `account` lock) and 30m passkey step-up in place for sensitive admin actions.
  - Native loader sign-in uses pushed auth requests (`POST /v1/auth/requests` → clean
    `lucent.moe/auth/device/lauth_...` URL) + loopback `127.0.0.1:<port>/callback` PKCE + DPoP →
    30-day rotating refresh token (30s retry grace) + 5m DPoP-bound access token.
  - Entity model and `can()` access control (hybrid config, multi-product from day one):
    - Closed union of `Action` permissions in code (`"tickets:reply"`, `"accounts:suspend"`, ...),
      with per-action `{ stepUp, audit }` metadata; zero `if (role === ...)` checks anywhere.
    - Pure `can(subject, action, target?)` shared by `platform` and `web` (including integer `rank`
      precedence `subject.maxRank > target.maxRank`); transactional `authorize(txNow, caller,
      action, target?)` enforces `can()` + 30m passkey step-up under `FOR UPDATE`.
    - Roles, optional plan templates and Discord sync predicates live in PostgreSQL (seeded from
      declarative config, editable live in `web` admin with step-up + audit); bootstrap `root` sits
      at max `rank` (transferred only via `ops transfer-superadmin`).
    - `Device` binds to `Account` (enroll PC P-256 key once per account; default `maxDevices = 1`,
      7d self-service replacement window); `Entitlement` covers 1..N products (`EntitlementProduct`:
      `productId`, `features: "*" | FeatureTag[]`, `channels`), unioned at `txNow`; `ProductSlot`
      serializes active sessions per `(accountId, productId)`.
    - Permanent confusable-checked `username_claim`; single-use 7-day account-only invites (no
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
- Spike first: whether `coreclr.dll` (.NET 9+) exports `DotNetRuntimeContractDescriptor`
  describing the runtime structures the navigation needs (unverified).
- A live probe in dev (Tamaki's `ChainCheck`) walks every chain in a running game with the
  candidate facts before sign-off.
- Out of scope: anything around osu!'s own client authentication.
- Order, after the facts machinery: memory source and kit split; `engines/dotnet` and lazer's
  foreign layer; host placement; features (relax, tap assist, aim assist, autobot and replay, with
  `humanize` as a library); stable; the `products/` entry.

## Open

- Release string hygiene (log stripping, hashed ids, string encryption). It shapes the logging API.
- Isolating our allocations from the game's heap.
- A generic "revise" round in an arbiter vs. a planner per domain.
- Script precedence policy (a product decision).
- RTTI and exceptions: confirm the `/GR-` decision when the first DLL boundary is built.
