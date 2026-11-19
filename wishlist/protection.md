# Protection wishlist

The protection backlog, split out of `wishlist.md`: delivery, running conditions, signals, keys,
strings and diagnostics, the virtualizer, obfuscation, and how it's operated. A backlog, not a
spec: entries leave as they land. Facts' own seams for this work stay in `wishlist.md` under Facts.

## Aim

- The aim is a crack that is never worth its cost, not one that is impossible: code on someone
  else's hardware can always be read in the end.
- No wall feeds another for now. Integrity is a signal the server scores, not key material: an
  interlock fails closed, so one bug in it locks every member out. A local dependence (a decode key
  derived from the lease code's bytes) waits behind the fact accessor and `LUCENT_VIRT` seams until
  the virtualizer can hide its consumers; a module with the server conversation patched out checks
  nothing until then.
- The adversaries, in order of what they cost us:
  - free users (no lease, offline): the server-held data is their wall;
  - sharers and resellers (one real account, many users): device keys, product slots, IP history;
  - lifters (after features and methods): the release binary, the virtualizer, obfuscation.
- The accepted bound: a crack built from one paid session (captured values, a patched lease check,
  no server) is invisible to the server and lives until our next release. A game update only makes
  the cracker capture again from the same paid account. Releases follow our own schedule; a
  re-seeded release per game update is revisited with the virtualizer, since until then a re-seed
  costs a cracker about an hour.
- So the release pipeline has to be cheap: its duration is our side of the race.

## Delivery

- Our own keys only, no Authenticode. The first loader download is trusted through TLS and the
  member session; every update after it through the keys inside the installed loader.
- Code runs only when the offline code key signed it: loader updates, `lucent-host`, modules.
  Online keys sign data only. A taken-over server can withhold a release, never run its own code on
  a member's PC. So no per-account bytes inside code: an account mark is an online-signed data blob
  beside the loader.
- The loader is downloaded from the member area only. One loader for every channel, with a channel
  selection; when it isn't the latest it does nothing but update itself.
- Channels are `stable`, `alpha` and `debug`: product tiers. `alpha` has fresher features and
  `stable`'s integrity posture. `debug` is for a handful of vetted people and drops integrity
  measures for performance.
- One current release per product and channel, and one current fact-set revision per release and
  module build. Publishing is staged, then promoted; promotion replaces. Going back means signing
  the old code under a new number: a client accepts only the highest number it has seen signed. A
  bad fact revision is fixed by the next one, or by an override meanwhile.
- A release is an offline-signed list of its artifacts and their digests, with that number: one for
  the loader and host, one per product and channel. A module's release names the `boot_info`
  version it starts under, so a loader change to the boot interface republishes every channel.
- Sessions running on a replaced release finish, up to a 12-hour session cap; the replaced release
  stays servable (leases, bundles) until they do.
- The module travels in our own pre-mapped container (sections, imports by hash, no PE headers),
  encrypted to the session, never on disk. The format lives in `contracts/`.
- `lucent-host` is its own small executable, shipped with the loader and signed by the code key.
  The loader verifies it through a handle held against writes, spawns it, and maps the module into
  it exactly as it maps into a game. Tokens and the device key stay out of the process that touches
  the game.

## Running

- To start, the server checks in one transaction: the account is active and the device key proves
  itself, an entitlement covers the product, the slot (the newest session takes a full one), the
  loader is the latest, the chosen channel has a current release, and `core` capabilities are
  covered for the reported game builds. Then the loader verifies, maps and boots the module.
- The loader stays running as the only network stack and relays opaque frames. At boot the module
  makes a one-time key pair; the server answers with its half, signed by the lease key, whose
  public part is in the signed image. The device key (loader) proves the PC, the session key
  (module) proves the running module, and everything from server to module is encrypted under it.
  A patched loader sees ciphertext and can only drop frames.
- Leases are renewed every 15 seconds and valid for 60. Each renewal carries the module's nonce,
  which the lease signs, and the lease carries a duration counted on the monotonic clock, so
  neither a recorded lease nor the system clock extends one. It binds session, device, product,
  release, entitled features and bundle revision. A slot is held by a live lease and frees itself
  when the lease expires.
- No server, nothing runs. When the server is unreachable, features go off at the next safe point,
  session keys and bundle data are wiped, and the module stays mapped and inert; a renewal within
  5 minutes resumes it, otherwise it unloads.
- A refusal (suspended, slot taken) unloads the module and the loader shows the reason. Integrity
  is never a reason.
- An entitlement that ends lets its session finish, up to the session cap. Suspension cuts at the
  next renewal.

## Signals

- Client signals only raise suspicion; they never clear it. Silence where a healthy session would
  speak is a signal. Bits and small enums, never inventories: no process or window names, no
  files. Nothing gates locally, and never on hypervisor detection (VBS).
- Classes: licensing (the server's own observations: sign-ins, device changes, session starts, slot
  takeovers, renewal gaps, IP addresses), health (fact and capability outcomes, failed features,
  crashes) and integrity (the next two entries).
- Hash challenges: each lease names a nonce and a small random range of our own code and constant
  data, and the answer returns in the next renewal.
  - The module reports its base once and the server applies relocations to its own copy, so no
    relocation data stays in memory. A contract test checks the expected hashes.
  - Hashed on a kit worker. The loader reads the same range from outside and answers
    independently; disagreement is a signal of its own.
  - The module reports whether its code pages are still non-writable.
  - A stored pristine copy can answer. Values only running code produces (live relocated pointers,
    runtime state) come only when the queue shows that happening.
- Environment, collected by the loader where it can: a debugger on the loader, host or game;
  hardware breakpoints on our threads; kernel debugging; test signing or driver signature
  enforcement off; the virtual machine vendor; the Windows build; modules in our own processes by
  signer class (Microsoft, other signer, unsigned), with the file hash of up to four unsigned ones.
- The hash and the probes are one library, `native/libs/integrity`, linked by the module and the
  loader, so the loader's independent answer runs the same code; the server's copy of the hash
  matches it through golden vectors in `contracts/`.
- Signals ride the lease renewal in a fixed-size field, at session start and on change. Weights
  live on the server; combinations carry the score.
- `debug` sends health events and no integrity signals.
- Identity is the device key, TPM-backed or software-backed (a mark staff see, not a score
  component). No TPM endorsement key. The loader also sends the system disk serial and board id,
  stored as keyed hashes: a low-weight hint for linking accounts.
- The scoring job fills a review queue. Each item has a risk score (how likely a violation) and an
  urgency score (how fast the harm grows) and names its contributing signals for staff. Members
  never see per-signal detail, appeals included. People act; nothing bans or revokes on its own,
  and no delay is imposed on acting.
- Retention: integrity signals, review evidence and raw IP addresses 365 days; health events 30.

## Keys and seeds

- Offline, on hardware, with a written signing ceremony: the code key (releases; cold) and the
  facts key (fact sets; used on every game update, and held by a second trusted person too, since
  it can't run code). A lost or stolen offline key is replaced through a new loader on the member
  site.
- Online: the lease key (leases, the session key exchange) and the override key (kill switches,
  per-account data). Their public halves ship inside the signed release, so rotating one costs a
  release; they are backed up.
- One 256-bit master seed per release and channel, generated at build, archived with the PDBs,
  never in git and never on the server. Subkeys per purpose: fact keys, event ids, API hashes, link
  order, later the instruction set.
- Identifier hashes are a keyed function. Kit's FNV-1a is invertible: a guessed name and its
  shipped hash give back the seed.
- The server gets a release pack: the fact and event manifests and what it needs to encode
  bundles. Rows are tagged with a release id, never a seed.
- Fact keys differ per release, so each release has the current game builds' sets signed again for
  it, per channel.
- Identifiers and link order rotate from the first release. Public values can be matched back to
  names by value whatever the hash; seeded identifiers protect the non-public facts and keep a
  cracker's notes from carrying over.

## Server inputs

- The lease and game data travel on separate channels.
- Game data keys and types are declared in game code (see Facts in `wishlist.md`).
  - The build exports a manifest, and server tooling validates bundles against it.
  - Only the container schema lives in `contracts/`.
- The release module discovers nothing. `libs/probe` (sig, schema, RTTI) is tooling and dev only,
  banned from release presets. Gate schema offsets too, so there's one rule.
- Every server value is validated. A bad value makes a requirement unavailable; it never crashes.
- Bundles are encrypted under the session key, expire with the lease, and are decrypted, used and
  wiped.
- Entitlement is enforced by withholding data. Data is delivered lazily, per feature.
- Public fact values (cs2 schema offsets, interfaces) are dumped by the community within hours of
  an update, so they are worth little on their own. The weight sits on what isn't public: recipes,
  integrity regions, session key material, and a bundle format that changes per release.
- No labeled tables. Kit's fact section is one today (kind, width, bound and the plain value per
  record, writable):
  - recipes (load-time derivation bytecode);
  - plans (copy plans run by a native executor).
- Per-release bundle layout rotation (recipe opcodes, plan encoding, key derivation, field and
  entry order, no descriptive data) waits for the virtualizer discussion: with replay accepted it
  mostly buys a generated encoder and decoder pair in two languages.
- No per-session watermarks or decoy facts while the machinery settles. A decoy would be a
  declared, unused fact whose per-session value the online key signs (a forged one is harmless), so
  a leaked fact table names its account.
- Configs and scripts can live in the cloud only, fetched per session with no release cache, and
  signed by the server, so swapping scripts is no way to tamper with the module. Cracked users keep
  what they grabbed and lose everything after.
- Dev: `loader-dev` takes local bundles signed with a dev key that release builds reject.
- The loader is the first target: it holds the device key, does PKCE/DPoP and starts the module.
  Its handoff and device-key code are measured and virtualized like the module's.
- Later:
  - fixups into code immediates;
  - per-user diversified builds would need an online key that signs code, so they stay out.

## Strings and diagnostics

The release image holds almost no strings to decrypt. Stack-XOR and similar schemes are out: they
emulate in bulk, and the decrypted strings then label the functions that use them.

- Identifiers (facts, features, settings paths, export and module names) are seeded hashes,
  `H(release seed, name)`. Nothing to decrypt.
- Diagnostics are events, not text, after Rust's `defmt`:
  - a call site emits an event id plus typed arguments (numbers, hashes, enums), with the name a
    `fixed_string` template argument hashed `consteval` under the release seed;
  - each event's descriptor (id, level, format, argument types) goes into a linker section, like
    facts; the post-link step extracts the manifest and strips the section;
  - dev renders events locally from the manifest, as text over the dev channel;
  - release keeps no logs: events go to an in-memory ring filtered by level; telemetry-level events
    go up encrypted over the session; a crash report carries the last events from the ring;
  - ids differ per release; the server maps them back through that release's manifest.
- User-facing error codes are a small, stable, curated catalog, explained on the site. They are
  not raw event ids.
- Menu text (labels, setting names, tooltips) comes from the server per session as a catalog keyed
  by the settings' hashed ids. The binary knows a setting only as a hash and a type. Localization
  comes with it.
- What's left:
  - generated at runtime where possible (window class, pipe and mutex names);
  - delivered by the server where possible (endpoints after bootstrap, font family names);
  - the irreducible rest (the loader's bootstrap URL) decrypted with lease and measurement key
    material inside a virtualized function, so a static emulation of the routine yields garbage.
- A release gate after the link: no declared fact, event, feature or setting name in the image, and
  no printable run over about 6 characters outside an explicit allowlist. A failure fails the
  build. Fact names are checked today; feature and setting names are not, and they leak: an
  invariant records its enclosing function's name, which for templates over a feature (`entry_of`)
  spells the feature's type. Release invariants and faults need a location without text.

## Virtualizer

Ground-up research, unlike what migrates from the old repo. Direction: a cooperative bin2bin
rewriter on the final linked image.

- Cooperative: the compiler makes the input easy and the rewriter refuses anything else, so it
  never guesses.
  - `LUCENT_VIRT` puts each marked function's address into a dedicated section. Mark the runner,
    decryption, lease and integrity code as it's written.
  - Marked functions build without jump tables and without SEH `__try`.
  - A refusal fails the release build, naming the function and the reason.
- Why bin2bin over an LLVM pass: it works on what an attacker sees, with no LLVM version lock, no
  question of whose allocator owns what, and no link-time optimization undoing the work. It also
  reaches the loader and code we didn't write. Plugins do load in the prebuilt clang-cl, with
  limits (`research/kb/llvm/clang-cl-pass-plugins.md`).
- Pipeline:
  - decode with Zydis (already a dependency); function list from the annotation section, bounds
    from `.pdata` through `pe`;
  - lift to our own small IR over the subset clang-cl emits for cold code; anything else refused;
  - flag liveness: drop flag writes nobody reads (the biggest performance lever);
  - lower to bytecode for this release's virtual instruction set;
  - rewrite: each body becomes an entry stub plus filler, bytecode in a new section, `.pdata` and
    unwind info updated.
- The interpreter is generated C++, compiled and linked into the module before the rewriter runs;
  the rewriter emits only bytecode and stubs. Only the entry and exit stubs are hand-written
  assembly. A rewriter that writes the interpreter's machine code itself can come later.
- Unwinding from day one: a foreign fault inside a handler unwinds through the VM frame to
  `contain()`, and `RtlLookupFunctionEntry` and crash dumps make sense there. The VM entry frame
  needs real unwind info.
- The optimizer undoes obfuscation written in source: clang-cl 23.1.5 at `/O2` folds
  `(a | b) - (a & b)` back into `a ^ b`.
  - The generator checks every form against the compiled handler, not the source.
  - Identities that must survive go behind an empty-asm barrier on one value (`asm("" : "+r"(v))`):
    no instruction emitted, the rest of the handler optimized normally.
  - Not `optnone` or `#pragma optimize("", off)`: every value spilled to the stack marks a
    handler at a glance, it's slow where speed matters most, and IDA cleans it up anyway.
- What rotates per release, against both kinds of devirtualizer:
  - against pattern matching: opcode map and operand encoding, handler set (merged and split
    handlers, superoperators), dispatch style, VM context layout;
  - against semantic analysis: operands under a rolling key that depends on the execution path,
    handlers whose meaning depends on the key, arithmetic obfuscation on the data path.
  - Opcode shuffling alone gets beaten by recognizing handlers.
- Known weaknesses of a naive VM, each a hardening step:
  - rolling-key constants in plain view: derive the key from measurements and the lease;
  - the same inlined fetch in every handler: vary the decode per handler, merge it into the
    arithmetic;
  - one meaning per handler: key-dependent handlers, superoperators, merging;
  - a mostly-empty handler table: decoy handlers, several opcodes per real handler;
  - a loop with one indirect call: threaded dispatch with the next address encrypted in the stream;
  - VM registers as a plain array: a context layout per seed, some state kept in native registers.
- Against MBA simplifiers (SiMBA, MBA-Blast, GAMBA, synthesis tools such as Syntia and Xyntia):
  - simplifiers beat the form of an expression, so the observable function has to be complex;
  - encoded VM registers: affine encodings modulo 2^32 with generator-chosen constants per
    register and program point, carried through add, subtract and multiply by a constant;
    XOR and rotates decode, operate and re-encode. Full encoding is white-box research;
  - constants derived from the key state or measurements, which no static tool can fold;
  - operations outside MBA theory (key-derived rotates, inverses, lookups);
  - a computation split across handlers through encoded VM memory;
  - MBA itself only as the outermost layer, for human readers.
- The function boundary is plain: entry and exit expose a protected function's inputs and output,
  so a simple function can be synthesized from samples alone. Virtualize functions whose behavior is
  inherently complex, or that depend on hidden state (lease, measurements, session keys) and can't
  be sampled in isolation.
- The recipe VM shares the instruction-set generator, not the instruction set: one seeded
  description produces the C++ handlers, the bytecode encoders (C++ for the rewriter, TS for the
  server's recipe encoder) and the contract test between them. The recipe runner is virtualized by
  the outer VM, under a different seed. The plan executor stays native.
- Opt-in, release-only, cold functions only, verified by tooling against a performance budget.
  Seeded per release, the seed recorded, `/Brepro` preserved.
- Tests:
  - instruction semantics against the real CPU: each form encoded with Zydis into a stub and run
    natively and in the interpreter on random states from a seeded RNG;
  - the rewriter end to end: a fixture DLL built by CMake, rewritten, loaded through the OS loader
    and `manualmap`, each function checked against its original on fuzzed inputs, and a fault in
    virtualized code unwinding to `contain()`;
  - a seed sweep over the same suite;
  - a red team: simplifiers run against the handler expressions, and synthesis against protected
    functions sampled at the boundary; the fraction reduced and the time per handler tracked per
    release.
- Phases:
  1. lift and interpret in-process, no PE rewriting: semantics, IR, CPU differential tests;
  2. rewrite: stubs, the new section, unwind info, the annotation section, on the fixture DLL;
  3. the seeded generator and rotation;
  4. hardening: rolling operand keys, key-dependent handlers, encoded registers;
  5. into the pipeline: release-only, cold-code checks, the recipe VM on the shared generator.
- Where it lives:
  - `native/tools/refract` from phase 1, banned from release presets like `libs/probe`. It is the
    bin2bin rewriter, not only a VM: the mutation backend and later passes share its decode, lift
    and rewrite;
  - extracted as code needs it: decoding, semantics and IR into a native library shared with
    probe; the runtime (stubs and
    generated handlers) linked into the module under the kit's mapped-module rules; `LUCENT_VIRT`
    in `kit` through a linker section like facts; generated handler C++ in the build tree only,
    like the shader headers;
  - `lucent_module()` gains a post-link step in the release preset; dev never runs it;
  - golden vectors for a fixed test seed in `contracts/`, which the C++ and TS encoders must match.

## Obfuscation outside the VM

The VM covers a handful of cold functions. The rest of the code mostly helps an analyst find the
walls, so the goal there is fewer clues and releases that don't diff.

- Removing clues: the strings design above; Win32 APIs resolved at runtime by seeded hash through
  one kit resolver; no RTTI, no shipped PDBs.
- Releases that don't diff: crackers port patches by diffing release N+1 against N (BinDiff,
  Diaphora).
  - Function and data order shuffled per release through lld-link's `/ORDER` file, when
    `lucent_module()` lands.
  - A mutation backend in the bin2bin tool, after VM phase 4: re-emit lifted code as mutated native
    code (instruction substitution, register reassignment, junk, split and reordered blocks) at
    near-native speed, for warm code the VM can't take.
  - Control-flow flattening and opaque predicates only later, as a seeded backend option: standard
    forms are undone by off-the-shelf IDA tools such as D-810.
- No LLVM-pass obfuscator: bin2bin covers it on the final binary.
- The rewriter emits an address map per release (original location to new), archived with the
  PDBs, so crash reports from protected code can still be symbolized.

## Operating it

- A release: build with a fresh seed, sign with the code key, regenerate and sign the fact sets for
  it with the facts key, publish staged, promote. `alpha` is where a protected build meets real
  machines first, and the release pipeline runs the differential tests on protected binaries,
  since VM, mutation and rewriter bugs appear only in release.
- A game update: ingest, generate, probe, sign with the facts key, publish. Until then members see
  "not yet supported".
- A deploy restarts inside the lease's 60 seconds, at worst inside the resume window.
- Antivirus false positives: with no certificate, SmartScreen and antivirus heuristics will fire on
  the loader, and virtualized code, runtime imports and a manual mapper add to it. Members are told
  to expect it; the loader's own protection stays lighter than the module's.
- Responding: staff act on an account (suspend, remove a device, strike the inviter) and it takes
  effect at the next renewal; an override turns a capability or feature off for every session at
  the next renewal; a crack ends with a new release. A serverless crack is found in the wild, never
  by the server.
- Metrics: the release pipeline's duration; game update to facts published, per module; review
  items per signal and how many were real; time from a release to its first known crack.

## Open

- What the `debug` channel contains, which decides how it is signed.
- A name for a release's signed artifact list (`release manifest` is the capability manifest).
- The local dependence behind the fact accessor seam, in the virtualizer and obfuscation
  discussion; a re-seeded release per game update, with it.
- Names: `refract`'s runtime library, and the shared decoding and semantics library.
- Cooperative bin2bin with a generated C++ interpreter: confirm.
- The VM's performance budget for cold code.
- Events replace the logging API entirely, with no free-text log calls even in dev.
- Which event levels leave the machine in release, and how long they're kept (the platform's
  retention tiers).
- SiMBA and GAMBA as Python dependencies for the red-team tests.
