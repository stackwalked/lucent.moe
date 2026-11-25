# Wishlist

Everything discussed so far that isn't built yet. A backlog, not a spec: entries leave as they land.
The roadmap orders it; the sections after it hold the detail.

## Roadmap

The aim: a game update, a new feature, a new game and a new product each cost one bounded,
checked piece of work. Old lucent's features and platform are the floor, not the target.

- A phase is its gate: what is true when it is done. Work in different roots (native, platform
  and web, research) overlaps freely.
- A phase leaves this list when its gate holds. Nothing here has a date: the measured numbers
  (update-day latency, release pipeline duration) are the schedule.
- Breadth waits for rails. No feature family is ported before the layer it sits on has one
  feature through it, tested without a game.
- Parity means every old capability is either here or cut in writing ("Cut", below), never
  silently missing.
- Entries marked (proposed) have not been discussed; they are this roadmap's own suggestions.

Where it stands (2026-11-19, four days in): slice 1 (authority, credentials, sessions, the web
shell and admin), the fact pipeline (kit facts and capabilities, the bundle format in C++ and TS,
probe, the generator, the offline Source 2 schema reader, 21 cs2 facts, late-loaded modules, the
update-day pipeline), the render stack, `ui` and `menu` drawing in cs2 behind Insert, kit's
registry, settings, safe point and draw dispatch, cs2's `world` and a player box, keyed identifier
hashes with the release guard and post-link name check, `refract`'s phase 1 and `integrity` are
built. So are most of slice 2 (devices, the `/v1` listener, sign-in, starts, leases, publishing),
the web pages that go with it, the module container, release seals under the offline code key,
kit's release boot path and lease client, and the release loader at its smallest (tested, not yet
run against a live server). `:check` runs every native test in Debug and Release. Not started: fact
sets on the server, slices 4 and 5, the rest of the cs2 game layer. No CI, and none planned soon: the commit hook's `:check` is the gate.

### Phase 0: rails

Built; what's left needs a person at a running game.

- The four cs2 facts confirmed in a running game, and a late module's facts resolving when it loads.

Gate: `loader-dev` maps cs2 with a dev-signed bundle and the module draws shaped text over the game
through our renderer.

### Phase 1: the licensed vertical slice

The spine. The thinnest path through every layer on a real release: one member, one PC, one
product, one feature. Built end to end, native and server together.

- Platform: promotion of staged releases. `ops publish-release` and `publish-loader` stage under a
  verified seal, but nothing outside the tests writes `current_release`, so no release is served.
- Platform, slice 2's rest: the start's `core` coverage check for the reported game builds (every
  build starts today). The loader's seal and artifacts are served on `/v1` (`GET /v1/loader`,
  `GET /v1/artifacts/:digest`) to any account entitled to a product.
- Facts reach release modules (fact-set storage, `ops publish-fact-set`, the start's core coverage
  per module from release manifest v3, the first bundle in the session reply, `/data` for late
  modules, kit and loader on the data route, landed). Left: promoting fact revisions (nothing
  writes `current_fact_set` outside tests; web's admin, below); `ops publish-fact-set` run for
  real (its tests call the function); a dev database holding v2 manifests fails starts until its
  releases are republished as v3. Live revisions, overrides, the reports route and scoring wait.
- kit takes a newer revision of a set it already holds for nobody: a set is known by its builds,
  so the rest of the session keeps the revision it started with. Live revisions decide how one
  is applied at a safe point; until then a promotion reaches the next session only.
- Web: admin promotion of staged releases and fact revisions; the download page's file, once the
  server serves one (it lists each channel's loader today); the product page's "not yet supported"
  from fact-set coverage, not only from a missing release.
- Native, the release loader's rest (`native/loader`, `native/host`, `libs/launch` landed):
  - a first run against a live server and a running cs2: sign-in, enrollment, self-update, start
    and relay are tested only in parts;
  - the release pipeline's loader half: building the loader and host in the release preset and
    signing their seal (`codekey sign-loader`) as a step, beside the module's;
  - `boot_info` with the host and build ids;
  - the game's process from `products/*.toml` instead of the loader's compiled-in table, and
    the cap of 64 reported module builds checked against what cs2 loads.
- Render: the menu usable mid-match, by toggling cs2's own relative-mouse mode through its input
  system while the menu is open (a method fact; it frees the cursor and stops the camera), and
  input the window procedure can't block (raw input read elsewhere, key polling). The per-session
  menu catalog from the server; release builds show placeholders until it arrives.
- cs2: the world and the registry's safe point moved from Present to the FrameStageNotify hook,
  which exists and runs only the view domain today; a class check on controllers instead of
  indices 1..64 (capabilities may hold vtable facts).
- Release tooling: the offline facts key as a passphrase-encrypted file with its signing tool
  (the key file format is the code key's; only `devkey sign` signs bundles today); the master
  seed's generation and archiving beside the release id; the production facts key list, for the
  release guard to compare against (today it only refuses the dev key) and for the release module
  to trust (it trusts none, so every release start is refused as `GAME_BUILD_UNSUPPORTED`).
- Prove `infra/` on staging; uptime monitoring and off-host backup custody are the owner's.

Gate: on a PC that has never seen us, a member downloads the loader from the member area, signs
in, enrolls, starts cs2 on `alpha` and sees the feature. Suspending the account ends it within the
lease TTL. A second PC takes the slot. A game update shows "not yet supported" until a signed
fact set is promoted, and the time that took is on record.

### Phase 2: the layers, complete

Every layer the features need, each proven by one feature, before any family is ported.

- Kit: the rest of Kit below (the registry's lapse policy and failed state, config store, binds).
- Render: `ui`, `menu`, theme and animation in full; HUD windows on plate; `tools/menu-shot`; the
  text and D3D11 leftovers (one atlas patch type, HDR targets, device rebuild, dev stats, the
  `frame_data` fuzz target).
- cs2 domains: `world`, `static_world`, `queries`, `events`, `targeting`, `view`, `command` with
  its stages, `prediction`, movement (simulator, planner, arbiter), `scene_draw`, `removals`,
  `inventory`. One exemplar feature per domain, tested without a game.
- The rest of `engines/source2/` (harvest, the interface finder) and of the finder language.
- Dev fault injection and live semantic probes; SteamCMD ingest.
- Finders for old lucent's 225 `methods.json` entries arrive with the domain that needs them, not
  ahead of it. Its hand-kept `*_layout.hpp` files become size and field facts.
- Health telemetry: fact and capability outcomes, failed features, crash reports with the last
  events.

Gate: a feature author writes views in and intents out and cannot reach foreign memory; each
domain has a feature on `alpha`; breaking one fact in dev turns off exactly the features behind
its capability and nothing else.

### Phase 3: cs2 parity

The families in "cs2 features" below, in the order their domains settled: visuals first (world and
scene), then aim and trigger (targeting, view, command), movement last (it leans on `prediction`,
the riskiest code in the layer, and its planner is redesigned from scratch). Presets, share
codes, scenarios and the benchmark come with the families they exercise.

Gate: every family old cs2 0.8.3 shipped is on `alpha` or listed under "Cut"; the owner plays on
the new module only.

### Phase 4: platform parity

Beside phases 2 and 3; nothing native waits on it except cutover.

- Slice 3, the rest (scoring, the review queue, retention tiers, update-day latency, data
  revisions raised by promotions and kill switches landed; a kill switch is recorded, not yet
  enforced): the signed override document and its delivery on `/data`, the reports route and the
  signals from it, the renewal's integrity bits and checked challenge answers. Each waits on a
  format the human decides; a review action of its own in place of `accounts:suspend`.
- `ops replay-removals` (what a `removed` line holds and who writes it waits on the human).
- Slice 4 (account-held items with history, share links, the member pages, tickets and appeals,
  the new-country review rule with DB-IP geo and resources, items served to and written by a
  session over `/data` landed): crash reports, the waitlist.
- Slice 5 (profiles, guides, comments, shouts, the inbox, reports and removal, posting
  restrictions apart from the licence, blocking, the data export, search, a presence stream
  landed): avatars (the codecs are dependencies to approve), presence shown in web, self-service
  account deletion (what survives it is undecided), `connectors/discord`.
- The public record: product status, known issues, the changelog, recovery time per game update,
  refusal-code pages, legal pages. Old lucent had no privacy or terms page.
- Member docs.

Gate: every surface of the old service, panel and bot is here or under "Cut".

### Phase 5: cutover

- Accounts, usernames, credentials where they can move (passkeys are bound to the RP ID
  `lucent.moe`, which is kept), licenses as entitlements, devices re-enrolled, cloud items.
- The old loader's last release points members at the new one. The old service goes read-only,
  then off.

Gate: no member depends on the old repo; it is archived.

### Phase 6: the walls

Research starts in phase 0 and runs beside everything; this is where it enters the pipeline.
Order follows what a wall costs a cracker per hour of ours.

1. From the first release (phase 1): keyed identifiers, no shipped names, the release gate on
   strings, link order shuffled per release.
2. Events replace logging (to confirm: open in `wishlist/protection.md`); APIs resolve by seeded
   hash.
3. Hash challenges, the loader's independent answer, environment signals: integrity joins the
   scoring phase 4 built.
4. `refract`'s VM, phases 2 to 5 (phase 1 lands in phase 0), then recipes and plans in place of
   the labeled fact table.
5. The mutation backend; the local dependence behind the fact accessor seam; a re-seeded release
   per game update.

Gate: `alpha` ships virtualized builds with the differential tests in the release pipeline; its
duration and the red team's numbers are tracked per release.

### Phase 7: scripts and extensions

See "Scripts and extensions" below. The value-only script host first, on cloud-delivered signed
scripts; then packages, review, the SDK and the directory; then rooms.

Gate: a member who is not staff has published an extension that others run.

### Phase 8: the second placement

osu, in the order "osu" gives. The loader becomes the app of "Loader" below: several products,
one session each.

Gate: osu runs on `alpha` under the same lease, bundle and protection as cs2, and landing it
changed no line of `kit` proper after the split.

### Phase 9: seed and launch

See "Community and launch". Cutover brings old lucent's members; the seed widens them, free, on
manual entitlements. Payments only after the seed's gates hold.

Gate (seed, from old lucent's M2): two game updates survived with the recovery time published,
weekly use holds, members have written extensions, the bug queue is under control. Gate (launch):
the seed converts, and a paid entitlement is issued with no staff action.

### Phase 10: engines

See "Engines and targets". Deadlock, then TF2, then one engine that isn't Valve's.

Gate, per target: it landed as a foreign layer, finders, domains and a `products/` entry. Kit, the
loader, the platform and the release pipeline changed only where an engine layer was extracted,
and the commit that extracted it says why.

### Always running: research

See "Research labs". Not gated; a lab graduates or is deleted.

### Cut

Decided against, so parity doesn't bring them back:

- Cohorts before launch, a repo-wide TypeScript CLI, `better-auth`, the staff AI agent in the
  Discord connector, `auth.lucent.moe`, the in-process bot.
- Runtime schema resolution and pattern scanning in the release module; stack-XOR strings.
- Dear ImGui; file-mirror cloud sync.
- `INTEGRITY_REFUSED`: integrity is never a reason shown to a client.
- Head surf and texture bug (old lucent's probe measured no hold); clantag (the game no longer
  allows it; the name prefix replaced it).

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
- A lint bans raw `add_library`, `add_executable` and `target_compile_options` outside
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

- `provenance.py` (a uv script, with the first `foreign/`).
- `-Wunsafe-buffer-usage` off by path in the foreign-memory layer; `misc-no-recursion` off by path in
  tools and tests once something there recurses.
- Lab C++ config sharing (clang-format and clang-tidy only search parents), with the first lab C++
  project; likely generated copies with a freshness check.
- Reopen generic code (`describe()`, enum introspection) when clang ships reflection; preconditions
  move to `pre(...)` when it ships contracts.

## Kit

- `boot_info` grows (v4 carries the session ends, the image kind, the mapper's trampolines, the
  bundle, and a mapped image's entry and `.pdata`):
  - host and build ids (the lease needs no field: the module's own hello gets the first one).
- No static TLS in mapped modules: `lucent_module()` fails the build on a TLS directory, ast-grep bans
  `thread_local`/`__declspec(thread)`, and our code bans function-local statics. A dependency that
  needs TLS is a decision: build it with `/Zc:threadSafeInit-`, keep it out of the module, or implement
  TLS through ntdll internals with a check per Windows build.
- Lifecycle (the resolve stage, hooks from facts, `hook_object`, the access boundary through
  `domain_token`, the counted `raw` escape hatch and the error model with RVA-only release faults
  landed):
  - the boundary's remaining hole: a feature can still call `foreign::read` on
    `memory_source::this_process()` directly, since `libs/foreign` arrives through kit's headers;
  - a test of the whole lifecycle end to end (its parts are tested alone);
  - `foreign_ptr32` owners for fields, when stable's foreign layer lands;
  - `raw` uses get promoted into proper APIs; the counter gates nothing yet.
- Features never hold kit resources while touching foreign memory. This closes the `/EHs` destructor gap.
- Feature registry (registry, states, wiring, dispatch, safe point, published views, the lapse and
  failed builds landed). A lease lapse stops every feature alike (decided: no per-feature
  exception, as "no server, nothing runs" says). Module builds are captured at attach, so a late
  module's build is missing from a failure record.
- Features never depend on features (lint: no feature header includes another). Shared logic goes into domains or plain libraries.
- Products strip features at compile time from the explicit feature list (`features/all.cpp`).
- Settings (`describe()` and per-tick snapshots landed): generate `describe()` with C++26
  reflection if Clang ships it (unverified).
- Config store (profiles, undo, scopes as a fallback chain keyed from outside, in memory behind
  `profile_storage` until phase 4's cloud store) and binds (`bind_slot`: always, hold, toggle;
  activity separate from on/off) landed. Still:
  - a profile carries which features are on too, so a switch changes the whole setup (decided);
  - menu UI for profiles, undo and choosing a scope; a weapon domain to feed `select_scopes`;
  - per-team visual settings (a box draws both teams in one frame, so it's per-entity, not a
    scope): a design call for phase 3's visuals;
  - more than one bind slot per feature, for chains;
  - profile ids minted by the cloud store in phase 4, not counted locally.
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

- Dev stats over the dev channel (the channel, text and incidents landed).
- A patience limit on worker shutdown: `worker_set::stop()` waits forever on a body that ignores
  its token, leaving the module loaded.

## cs2 game layer

- Domains with concrete APIs. Each one states its own rule for resolving competing features.
- `world`:
  - a plain-value snapshot with index+serial entity handles;
  - built every frame stage;
  - published to the render thread through a triple buffer;
  - built on demand only once a profile shows it matters.
- `static_world`: collision data kept for the life of a map.
- `command` (stages, one owner each, stage tokens, `emit`, `rapid_fire` landed). Its rule, kept by
  the human: a button belongs for the tick to the earliest stage asking, and the player's own steps
  for it give way. Still: async command send turned off while we write (decided, as old lucent
  did), since a remote server may otherwise get an earlier copy.
- `prediction`: a what-if repredict owned by the game layer (scratch write, then restore). The
  riskiest code in the layer. Decided with the human: we run the command ourselves (multi-tick),
  not the game's one-tick `ClientSidePredict` path, saving and restoring through the game's own
  per-entity `SaveData`/`RestoreData` rather than a hand-kept copy. The spike
  (`research/kb/cs2/prediction.md`, 1.41.9.9) settled, with the human, three additions and the
  entry point:
  - our own save storage, built with the game's constructor and swapped into `entity+0x5a0` around
    each call, since saving into the game's slot n deletes every slot above it;
  - a byte-copy supplement for what `SaveData` misses (most of the 0xfe0-byte services object,
    `v_anglePrevious`), over the pawn, controller and active weapon;
  - the game's suppress-effects flag set by us around each run;
  - runs call `DoMovement` with our own tick base and clock set up, skipping the controller's
    thinks and the tick-base write; the three pawn virtuals still run weapon logic, so what-ifs
    run on a copy of the command with attack cleared.
    Then:
  - restore completeness proven by a dev probe (pawn and services bytes equal after any what-ifs,
    outside a declared volatile list with a reason per entry), with results recorded;
  - restore outside `contain()`, since a foreign fault skips destructors; a fault marks the domain
    failed for the session;
  - game thread only, between the movement stage and command apply, behind a phase token, with a
    budget per command; features never call it; aim gets "self after movement" as a view;
  - one final repredict per command after apply, so the pawn matches the command sent.
- `view` (the mouse model, owed counts, adding requests, `quick_turn` landed). The setter is a
  leaf without unwind data, so `view` writes the two places it writes, offsets read off the
  setter by finders (decided over relaxing the method check). Still: counts at the current zoom
  scale, `mouse_inverty`, the sv_cheats pitch path.
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
  - the planner gets redesigned from scratch. Decided with the human:
    - a goal is a kit feature with `propose`, `on_retime` and `confirm`, and no capability
      flags; it keeps its own state and hears outcomes through the next tick's view;
    - one arbiter rule: class (safety, committed, leading, rest; each goal declares the highest it
      may use), then a declared precedence table, then rank, then the smaller intervention;
      channels go to the first plan claiming them, and a plan losing any channel drops whole;
    - retime to a fixpoint, at most two rounds;
    - a pure simulator (no game access, clock or statics; collision behind an interface, answered
      by `queries::trace` until `static_world` matches the game's faces);
    - every subtick step, aim's attack included, goes through movement's one pure `emit`, which
      refuses with a reason instead of dropping; other stages send button requests;
    - heading is a request to `view`, never a direct yaw write;
    - tick budgets, not deadlines, so decisions are reproducible; a wall-clock cap stays only as
      a guard that sends the baseline;
    - when a critical tick's last candidate fails its prediction check, the baseline goes out;
    - `request_still` lands one tick later (world, then movement, then command apply);
    - tests: golden trajectories recorded live with build and map as provenance, arbiter tables,
      randomized legality tests for `emit`.
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

- left over from delivery and the first generator (`tools/facts`, `targets/cs2/finders`, four
  cs2 facts): TimeDateStamp read by `pe::image_view`, not kit; one fact-section reader for devkey
  and the facts tool; finders naming their fact by symbol once the foreign layer is a library they
  may include; the four facts confirmed in a running game; facts of a module the game unloads
  invalidated (they point into the freed image until safe points can retire them);
- the rest of the finder language: operand alternation, steps in either order, sequences across
  `.pdata` chunk splits, facts depending on facts (ordered, cycles an error), the cached per-build
  index, changes against the last published set;
- the read-only section between safe points; a `core` capability in a late-loaded module waiting
  rather than refusing the start (decided; see phase 1's Kit entry);
- release key handling: the production facts key list the release guard compares against (it
  refuses only the dev key today).

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
  serves the current revision for each reported module build: the latest promoted, with no
  falling back to an older one.
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
    a `core` capability needs, or whose revision isn't newer. It knows the release's facts and
    core capabilities from the release manifest (`contracts/release-manifest/v3`, written by
    `facts manifest`: each fact with its game module's name hash), which `publish-release` uploads.
    A set must carry the core facts of the modules it lists, and a start is refused only for a core
    capability whose modules were all reported and aren't covered; one in a module not loaded yet
    waits. The manifest's game id is the product id (`products/<id>.toml`); Steam's app id stays a
    label.
  - load: bundle signature, format and module keys; the per-kind checks against the loaded image
    (`RtlLookupFunctionEntry` for methods), header reads through `contain()`. A failed fact makes
    its capabilities unavailable; telemetry reports its key and module build.
  - use: reads trust their facts; only a foreign fault fails one, through `contain()`.
- Dev fault injection over the dev channel marks any fact invalid.
- Live semantic probes: capabilities declare dev-only probes (value ranges, handle serials); the
  update-day pipeline runs them in a real game before sign-off.
- Three documents, two keys:
  - fact set, per manifest digest, module build and revision, signed with the offline facts key
    after sign-off. Header: format, game, module build key, revision, finders commit, manifest
    digest. Entries are `(key hash, payload)` leaves sorted by key under a Merkle root; the
    signature covers the header and the root. Payloads are opaque bytes (a value now, a recipe
    later). Fact keys differ per release, so a set is signed for one release.
  - overrides (force features or capabilities off), signed with an online server key: a kill switch
    needs no offline key, and the worst a stolen online key does is what withholding already can.
  - session bundle: the entitled entries with their Merkle proofs plus the overrides, bound to the
    session and encrypted under the session key.
- A compromised server can withhold facts, never forge one: values are trusted only through the
  offline key.
- Delivery:
  - the loader sends the module build keys; per module build the server picks the current
    revision for the release's manifest and drops entries the session isn't entitled to;
  - a module with no set is "not yet supported" and its capabilities are unavailable; the server
    refuses the session only when a `core` capability is uncovered;
  - in release the first bundle rides the session reply, beside the first lease, under the session
    key (decided: one round trip fewer at boot); `boot_info`'s bundle is dev only. A late-loaded
    module's set, revisions and overrides come over the data route and apply at a safe point;
  - Phase 1 delivers every entry of a set: withholding per feature needs the manifest to map
    features to the capabilities they need, which version 2 doesn't (a version 3, then). The data
    request carries an optional feature list from its first version, so asking per feature later
    needs no new one.
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
  Agents may run everything before sign-off; signing with the facts key and publishing (staged,
  then promoted) are always a person's.
- A broken finder makes its facts fail and its capabilities unavailable. A partial set may be
  published when no `core` capability is affected; the finder fix lands as the next revision.
- Metrics: update-day latency per module and per step; load failures reported from the field.
- Seams for the protection work (designed in `wishlist/protection.md`):
  - every read of a fact value goes through one kit accessor, so storage can become encoded later
    by changing one function (and decoding stays about a load and an XOR);
  - a payload carries a tag: a literal now, a recipe later, evaluated by one resolve function, and
    validated on what it yields;
  - key hashes are a keyed function of the release's fact subkey and the name from the first
    release (not FNV-1a, which gives the key back), the subkey from the generated `lucent::build`
    header (fixed in dev). Telemetry keys are per release; the server maps them
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
    and handoff flows, member area, admin area including promotion of staged releases and fact
    revisions and override kill switches). Replaces the old service's handwritten `pages.ts` and
    `den gen auth-tokens`.
  - `contracts/`: cross-runtime wire and binary container schemas and golden vectors only.
  - `products/`: checked-in product catalog (`products/<id>.toml`: `id`, `kind`, ordered release
    `channels`, default device/slot policy), read by `platform/`, `web/` and build tooling.
- Scope changes from old `lucent`:
  - Invite and waitlist admission with manual licenses only; no cohorts, no billing or checkout.
  - No repo-wide `den` CLI; no `@anthropic-ai/sdk` agent in `connectors/discord`.
  - Fact sets stay signed by the offline facts key (`Facts`); `web/` admin promotes staged
    revisions and manages online-key overrides with passkey step-up.
  - Reviewed `.lpkg` extension packages, `/sdk/v1` and WebSocket `Rooms` wait past the initial five
    slices until the value-only Luau script host settles; cloud sync still carries `.luau` scripts
    and `resources` serves admin-curated files.
- Vertical slices (directories appear only with their slice):
  1. authority, credentials, sessions and `web/` shell + admin people/audit;
  2. PC enrollment, native `/v1` starts, sessions, leases and module/loader releases. Decided:
     - the `/v1` flow (old lucent's reserve, handoff and redeem, its bootstrap grant and the
       module's own WinHTTP are gone; its operation-id receipts, rate limits, slot generations,
       sequence and deadline arithmetic, and 503-for-the-unexpected stay):
       - `POST /v1/enrollments`: proven by the candidate device key; approved in the browser
         after a recent sign-in, with a match code from the key's thumbprint; the loader polls;
       - `POST /v1/starts` (loader): product, channel, loader release id, module builds; every
         start check in one transaction; returns a start id, the release seal and a fresh
         per-start key that opens the module container; the start expires unused after 60 s;
       - `POST /v1/starts/:id/session`: the module's X25519 hello, relayed opaquely by the
         loader; binds the key, consumes the start, takes the slot; returns the server's half
         and the first lease, signed by the lease key;
       - `POST /v1/sessions/:id/lease` every 15 s, `/data`, `/reports`, `/close`: the loader's DPoP
         around the module's AEAD frame. Close frees the slot at once; a crash drains it when
         the last lease expires;
       - DPoP freshness by clock window as old (`iat` at most 5 s ahead, 300 s behind, the
         client's offset from `Date`, one retry, a `jti` replay table); no server nonces;
       - each loader release seal carries a number, and the loader refuses any not above the
         highest it has seen signed;
     - one slice built end to end, native and server together, not split like slice 1;
     - without a usable TPM 2.0 the device key falls back to a non-exportable CNG software key,
       recorded on the device as software-backed for risk scoring and staff to see, so no PC is
       locked out by hardware;
     - when a product slot is full, the newest session takes it: the old session's next renewal is
       refused and it lapses within the lease TTL, so a crashed loader never blocks a restart;
     - the loader renews the lease as a relay and the module holds an end-to-end session key;
       delivery, running conditions, signals and keys are in `wishlist/protection.md`;
     - channels are `stable`, `alpha` and `debug`: `beta` leaves `products/*.toml` and `debug`
       joins, and `releases:toggle` becomes a promote action.
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
  - Delivery: ≤180 KB gzipped JS per first load (`web:budget` fails over it), back to the aimed-for
    150 once full zod is out of the browser (26 KB of it: `validateSearch`, list filters and
    `core`'s scalars on `zod/mini` or plain guards), route-split chunks, Plex
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
  - `core`, `rpc`, `policy`, `catalog` and `testing` landed in `platform/packages/` (moon ids
    `platform-core` and `platform-testing`: native has `core` and `testing`); web's HTTP-level
    integration tests are `testing`'s second consumer (`web:integration`);
  - the native `/v1` listener, in the slice that gives it routes (boot, the internal listener,
    the job runner, `ops.ts` and `server:dev`/`server:seed` landed);
  - `web/` landed on the slice 1B pins (in `web/package.json`) without Nitro: Start's build
    exports `{ fetch }`, which `web/src/main.ts` serves from `Bun.serve`, and the entry hands
    each request's CSP nonce to the router through `fetch(request, { context })`. Found on the
    way: the server-fn input method is `.validator` (not `.inputValidator`), and server
    functions demand `Origin` + `Sec-Fetch-Site` and seroval-encoded bodies;
  - optional plan templates and `connector_discord_rule` tables when their consumers land.
- Auth, credentials, sessions and authority:
  - No `better-auth`: old lucent spent too long fighting it, and its model has no room for the
    native DPoP flow. Browser credentials and sessions landed in `platform/server/src/auth/` with
    migration `0002_credentials.sql`; new passwords are checked against Have I Been Pwned's range
    API, and a job sweeps expired sessions, flows and setup links. Still to land with them:
    - `jose@6.2.17` for client P-256 DPoP proofs, with the native loader's sign-in. (Web's
      per-IP sign-in throttles landed in its gateway; its browser WebAuthn uses the platform's own
      JSON helpers, so `@simplewebauthn/browser` isn't needed.)
  - Native loader sign-in uses pushed auth requests (`POST /v1/auth/requests` → clean
    `lucent.moe/auth/device/lauth_...` URL) + loopback `127.0.0.1:<port>/callback` PKCE + DPoP →
    30-day rotating refresh token (30s retry grace) + 5m DPoP-bound access token.
    - The DPoP key is the device key (TPM or CNG software P-256), so every native request also
      proves its PC, and enrollment and sign-in share one key.
    - A refresh token presented again after its 30s grace revokes its whole rotation family.
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
    - Roles, optional plan templates and Discord sync predicates live in PostgreSQL (seeded from
      declarative config, editable live in `web` admin with step-up + audit); bootstrap `root` sits
      at max `rank` (transferred only via `ops transfer-superadmin`).
    - `Device` binds to `Account` (enroll PC P-256 key once per account; default `maxDevices = 1`,
      7d self-service replacement window); `Entitlement` covers 1..N products (`EntitlementProduct`:
      `productId`, `features: "*" | FeatureTag[]`, `channels`), unioned at `txNow`; `ProductSlot`
      serializes active sessions per `(accountId, productId)`, in `device`,
      `device_change_window` and `product_slot`.
    - Permanent confusable-checked `username_claim`: the fold table is every Unicode
      `confusables.txt` 18.0.0 entry whose source is an ASCII letter, digit or underscore, after
      case folding (0→o, 1→l, i→l, m→rn, `_` dropped); single-use 7-day account-only invites (no
      cohorts) with inviter strike attribution.
- Native contracts, lease channel and bundle pipeline:
  - `contracts/` holds canonical little-endian versioned binary container definitions, `/v1` wire
    Zod schemas, and committed golden `.bin`/`.json` vectors verified by both `ctest` and
    `bun test`. Zero codegen until hand-mirroring hurts.
  - Key split: **Ed25519** over raw canonical bytes for server and offline authorities
    (the offline code and facts keys, `LEASE_SIGNING_KEY`, `OVERRIDE_SIGNING_KEY`), including a
    fixed-layout binary Ed25519 runtime lease (dropping `lucent-lease+jwt` so the mapped module needs no JSON or
    JWS parser); **ECDSA P-256** only for the device key, because the TPM forces it; **X25519**
    for the module's per-boot session key exchange and **XChaCha20-Poly1305** for its frames, both
    from Monocypher, so the module needs no OS crypto import and no second curve library.
  - Every signed document starts with its own context string and version (e.g. `lucent lease v1`),
    so a signature over one kind is never accepted as another; one key signing two kinds (the lease
    key: leases and the session key exchange) stays safe.
  - Ed25519 verification is strict on both sides (non-canonical encodings and small-order points
    refused), pinned by vectors in `contracts/` that Monocypher and Bun's WebCrypto must both pass.
  - Encoding: every native-facing message is canonical little-endian binary in `contracts/` with
    golden vectors, like the bundle, except the OAuth endpoints (PAR, token), which stay standard
    (form requests, JSON replies); the loader carries a minimal parser for the token reply only.
  - Separate `/v1` channels, decided: `POST /v1/sessions/:id/lease` (15s cadence / 60s TTL, carries
    the data revision, which rises when the session's facts or overrides change, and a hash
    challenge, never game data); `POST /v1/sessions/:id/data` (what the server sends the module:
    fact-set entries with Merkle proofs and the override document, later the menu catalog, cloud
    configs and scripts; each request names what it needs, per module build in Phase 1); and
    `POST /v1/sessions/:id/reports` (what the module sends back: health events and crash
    summaries, batched and capped). Each route has its own key and sequence per direction, from
    the session secret with the route in the derivation, so routes never stale each other.
  - No `INTEGRITY_REFUSED` on `/handoff` or `/lease`: a mismatch changes nothing the client sees.
    It appends `risk_signal` rows (tagged with a release id) for risk scoring and review items
    that staff act on.
  - `ops publish-release` / `publish-loader` / `publish-fact-set` verify offline signatures,
    manifest digests, revision monotonicity and `core` coverage; `web` admin promotes staged
    releases and revisions, manages online-signed overrides, and tracks update-day latency per
    `module_build_key`.
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
- Staging acceptance for `infra/compose.yml`, `infra/caddy/` and `infra/ops/`:
  - On a fresh host with real DNS, TLS and secrets, bootstrap and finish setup through Caddy;
    publish and promote a loader and download it as a member. Audit the redacted proxy logs.
  - Redeploy a migration with the same PostgreSQL instance; verify epoch handover and the web
    skew window. Restore a backup on an empty host, verify schema, root sign-in and download.
  - Add Discord when its connector lands. CI is separate; migrations and DB verbs stay in platform.

## osu

Tamaki (github.com/gorelace/tamaki: a standalone exe reading osu! from outside, SendInput, its own
DX11 overlay window; lazer and stable) is rewritten here as a second product, the osu project.
`libs/foreign` (memory source, `foreign_ptr`, `foreign_ptr32`) and kit's `read_access` and
`write_access` have landed.

- Decided:
  - one product format (a module plus fact bundles) with two placements: mapped into the game
    (cs2), or into a `lucent-host` process the loader spawns per product (osu: remote reads, an
    overlay window, an input domain); same lease, session, lifecycle and protection;
  - `read_access` carries the memory source, so domains and features don't change between
    placements; the source the host-side fact resolve reads images and vtables through;
  - `kit` split by placement: facts, registry, context, settings and session stay in `kit`; hooks
    and in-game Present go to `kit-internal`; attach loop, remote reads, overlay window and input
    injection go to `kit-external`;
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
- Order: the kit split; `lucent-host` and its attach loop; the .NET harvest; `engines/dotnet` and lazer's
  foreign layer; the osu domains (play state, input, overlay window); features (relax, tap assist, aim assist, autobot and replay, with
  `humanize` as a library); stable; the `products/` entry.

## cs2 features

What old cs2 0.8.3 shipped, by family, with the domain each waits on. The old menu schema
(`modules/cs2/src/ui/menu/schema.cpp` in old lucent) is the full list of options; this is the
checklist of families. A family leaves when it is on `alpha`.

- Rules carried over: no netvar is written to get an effect; nothing forged goes to Steam or the
  game coordinator; aim output is whole mouse counts under a real mouse's rate (8 kHz).
- Scopes: aim settings per weapon, falling back through the weapon's class; player visuals per
  team. Every switch takes a bind (hold, toggle, always).
- Players (`world`, `scene_draw`): esp parts with the drag-to-side layout editor, flags, distance
  fade, legit sync; off-screen arrows, sound rings, radar; chams layers and looks; our own glow;
  xray from baked collision (`static_world`).
- Self (`view`, `removals`, `scene_draw`): fov, aspect, third person, spectate anyone; viewmodel
  offsets; first-person chams; the removals set; scope lines.
- World, weapons, post (`scene_draw`, `events`, `queries`): night, weather, custom sky, world
  colours; bomb and dropped-weapon esp; hit feedback, tracers, impacts, sounds; grenade path,
  warning and timers; the post-process chain.
- Aim (`targeting`, `view`, `command`): assist and lock, the shared target stage, recoil control,
  trigger with hit chance, zeus and knife bots, auto stop and scope.
- Movement (the movement domain): strafing, the jump set, jump bug, edge bug, pixel surf with
  spots and chaining, the helpers, route practice, effects on triggers. Requirements old lucent
  learned late: the target surf is locked at the jump even when not drawn; always-on and key-held
  behave the same; a second smart key per feature for chains.
- HUD windows (`ui` on plate): watermark, keybinds, spectators, bomb timer, team damage, damage
  and event logs, velocity, key display, jump stats, indicators; the layout editor.
- Inventory (`inventory`): the changer and loadouts, custom paints, the coordinator firewall.
- Misc: auto accept, vote reveal, name prefix, config share codes, autoload.
- Restricted features (nospread, optimal strafe, null strafe) become an entitlement feature tag,
  not a menu switch.
- Decide before porting, each a product call:
  - the Scaleform 2018 HUD (17 Panorama scripts, 10k lines, art that was hard to recreate):
    port, rethink as an extension, or cut;
  - the music library and audio engine: kit service, or an extension over `@lucent/media`;
  - which features `stable` lacks. Products strip features at compile time; old lucent's
    `features.toml` design was never built.
- Never built in old lucent, still wanted or undecided: backtrack, grenade throw helpers, ledge
  grab in the simulator, rank reveal, fake lag, kill dissolve.
- Carry over as `research/kb/` pages, re-verified against the current build as each domain needs
  them: old lucent's 22 `docs/re/` notes (process-movement, subtick, prediction, command-send,
  world-collision, pixel-surf, shaders, panorama).

## Loader

The release loader appears in phase 1 at its smallest and grows into old lucent's app. Its trust
rules are in `wishlist/protection.md`.

- Phase 1's loader is a console program (sign-in, device key and match code, self-update with a
  way back, verify before parse, map, relay, the refusal's code); its window comes with the app.
- The app (phase 8): products as rows, one session each; tray and background; start with Windows;
  auto-load per product (attach to a running game, never launch it); a rotating log; crash report
  review and send on a click, the dump never leaving the PC; `forget` and `uninstall`.
- Its window runs on `libs/render` in a standalone window, the same stack as the menu.
- Refusal messages are the curated error catalog, explained on the site.
- Open: whether targets stay compiled in or a product's host and module are all the loader needs
  to know (the placement model suggests the second).

## Scripts and extensions

Old lucent had Luau in the module, 27 `@lucent/*` libraries, `.lpkg` packages, review and signing,
`lucent-sdk` with an MCP server, a DAP debugger, rooms. The new host changes the contract: values,
not live handles.

- Order:
  1. the script host as designed under "cs2 game layer": a script is a feature, with `needs` and
     `wants`, budgets, and the registry's failed state;
  2. cloud-held scripts, server-signed, fetched per session;
  3. `.lpkg` in `contracts/`, the publish checks, staff review with step-up, the install set over
     the session, takedown and the stop list;
  4. the SDK (`check`, `pack`, `watch`, `publish`, definitions per release) and the analyzer in a
     child process; the MCP server; the debugger and compile-first reload in developer mode;
  5. the directory: search, installs, author profiles;
  6. rooms, with the install check at join that old lucent never built.
- The library surface is rebuilt per domain: a library exists when its domain can hand out values
  under a stated conflict rule. Rendering (2D recordings, 3D scenes, materials) rides `draw` and
  `scene_draw`.
- Permissions stay manifest-declared (`command`, `settings`, `http` with hosts, `rooms`, `sync`,
  `cvars`, `media`).
- Old lucent's unbuilt list: library dependencies, private packages, an input library,
  deprecation shims, fuzzing the host before anyone but staff publishes.
- (proposed) Ratings and comments on directory items, reusing profile comments.
- (proposed) A settings tool on the MCP server, so an agent can read and propose config changes
  without `eval`.
- (proposed) Extensions declare the products they run on, so the directory spans games.

## Community and launch

- Admission: invites from an admin-granted allowance, waves, strikes one level up, the invite
  tree; the waitlist as a state machine with a handler. A vouch fast-tracks an applicant; whether
  the vouch is the invite or a field is still open from old lucent.
- The seed: 30 to 50 people approached directly, free, a `founding` mark kept afterwards.
- The public record is the marketing: status with a named staff contact, the changelog, recovery
  time per update. Never "undetected", never feature-list comparisons, no resellers.
- Configs: a site editor from the release's settings manifest, support reading a config with
  per-ticket consent.
- Payments (after the seed's gates): old lucent's design stands as the starting point, to be
  re-decided when it starts: stablecoins, self-hosted, a derived address per account, a watcher
  with two providers, a spend-only ledger, plans and renewal as entitlements with an end, the
  founding rate, staff adjustments with step-up, books. One offering, no tiers, no lifetime keys.
  Its open items (chains at launch, refunds, cash-out, the accountant's and lawyer's answers) are
  blockers, not details.
- Launch, after the seed: applications in capped cohorts (the one place cohorts return), growth
  by vouching.
- (proposed) Guides written by members, with the same review as extensions.
- (proposed) Jump-stat and route boards per map, opt-in, from values the module already computes.
- (proposed) Staff below admin: a support role in `can()` for tickets only.

## Engines and targets

A target is a foreign layer, finders, domains and features. An engine's probe is its own layer
from the first target; its foreign mirrors and domains are extracted when the second arrives.

- Deadlock: the second Source 2 target. Moves the Source 2 foreign mirrors to
  `engines/source2/foreign/` and settles which cs2 domains were Source 2 domains all along
  (`world`, `view`, `scene_draw` likely; `command` and movement not). Old lucent's research called
  it the first choice; Valve's anti-cheat there is the stated risk.
- TF2: `engines/source1/`. No schema system: fields come from datatables and RTTI, so the engine's
  probe needs its own derivation and harvest. Needs a render backend for whatever the game
  presents through, decided by measurement at the start (unverified: Direct3D 9, 64-bit).
- One engine that isn't Valve's, as a lab first: Unreal (the reflection tables as the schema
  analogue) or Unity IL2CPP (metadata as the harvest, close to `engines/dotnet`). A `kb/` page per
  engine before any code. Which game is open.
- Each target states its own rules the way cs2 does (what is never written, what never leaves).
- What must not change per target: kit, the bundle and release formats, the loader, the platform
  beyond a `products/` entry. If it does, that is the finding.

## Research labs

`research/lab/` projects, held to full code rules, graduating into the product tree or deleted.

- The virtualizer (`wishlist/protection.md`): the first lab, phases 1 to 5.
- rikai (the decompiler, its own repo): the natural red team for the virtualizer, and a question
  to settle early: whether the lifter and IR are shared or deliberately independent, so the
  attack isn't written against its own front end.
- Interlocked protection: `kb/` pages on the published work (self-checksumming, oblivious hashing,
  guard networks) before the local dependence behind the fact accessor seam is designed. Nothing
  of ours exists yet.
- Leak attribution: the want is every served build identifiable. Old lucent's fixed set of link
  order variants per release doesn't scale to that, and per-user code breaks the rule that only
  the offline key signs code. Open research: marks carried in online-signed data.
- Kernel and hypervisor: exploratory only, no product decision. A lab would need its own signing
  lane and a test VM; the product never gates on hypervisor detection.
- Toolchain: the modules trial; reflection when clang ships P2996.
- Old lucent's goal that members aren't put at risk by how the module loads, hooks or talks has
  no home in the protection model, which covers licensing only. Where it lives is open.

## Open

- Isolating our allocations from the game's heap.
- A generic "revise" round in an arbiter vs. a planner per domain.
- Script precedence policy (a product decision).
- RTTI and exceptions: confirm the `/GR-` decision when the first DLL boundary is built.
