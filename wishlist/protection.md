# Protection wishlist

The protection backlog, split out of `wishlist.md`: integrity, licensing, strings and diagnostics,
the virtualizer, obfuscation, and how it's operated. A backlog, not a spec: entries leave as they
land. Facts' own seams for this work stay in `wishlist.md` under Facts.

## Aim

- The aim is a crack that is never worth its cost, not one that is impossible: code on someone
  else's hardware can always be read in the end.
- Walls interlock: getting past one breaks another's inputs (a patched signature check changes a
  measured region, which changes the key the bundle decrypts with). No wall is a standalone check
  that can be beaten on its own.
- The adversaries, in order of what they cost us:
  - free users (no lease, offline): the server-held data is their wall;
  - sharers and resellers (one real account, many users): device keys, product slots, watermarks;
  - lifters (after features and methods): the release binary, the virtualizer, obfuscation.
- A cracked release should go stale before it pays off: rotation per release, and a release
  pipeline cheap enough to ship one in response to a crack.

## Server inputs and licensing integrity

- The lease and game data travel on separate channels.
- Game data keys and types are declared in game code (see Facts in `wishlist.md`).
  - The build exports a manifest, and server tooling validates bundles against it.
  - Only the container schema lives in `contracts/`.
- The release module discovers nothing. `libs/probe` (sig, schema, RTTI) is tooling and dev only,
  banned from release presets. Gate schema offsets too, so there's one rule.
- Every server value is validated. A bad value makes a requirement unavailable; it never crashes.
- Bundles are encrypted per session (key from the lease), expire with the lease, and are
  decrypted, used and wiped.
- Entitlement is enforced by withholding data. Data is delivered lazily, per feature.
- Public fact values (cs2 schema offsets, interfaces) are dumped by the community within hours of
  an update, so they are worth little on their own. The weight sits on what isn't public: recipes,
  integrity regions, session key material, and a bundle format that changes per release.
- No labeled tables:
  - recipes (load-time derivation bytecode);
  - plans (copy plans run by a native executor).
- Per-release format rotation from the release seed:
  - recipe opcodes;
  - plan encoding;
  - key derivation;
  - struct field order;
  - the bundle carries no descriptive data (names, types, lengths a decoder could do without),
    and entry order follows the seeded key hashes, so it differs per release.

  A cracker with public values still has to encode a bundle this release accepts, which means
  getting past the signature, then the format. The server encoder and the module decoders come
  from the same seed, with a contract test between them.
- Per-session watermarking: equivalent but distinct bundles.
- Canary facts: one fake, harmless fact per session. Seen in another session's telemetry, it
  marks a replayed bundle.
- Configs and scripts can live in the cloud only, fetched per session with no release cache, and
  signed by the server, so swapping scripts is no way to tamper with the module. Cracked users keep
  what they grabbed and lose everything after.
- Integrity as key material:
  - `measure`/`mix`/`derive` ops, with regions chosen by the server per session;
  - the runner measures itself;
  - server-side challenge/response;
  - measurement that a pristine copy can't answer: besides hashing bytes, values only the running
    code produces (live relocated pointers, the module's runtime state), so a fake has to emulate
    running code, not keep a file.
- Measurement accounts for relocations and fixups. A contract test checks the expected hashes, and
  mismatch telemetry is tagged with the release seed.
- Debugger and VM checks are signals only: risk scoring on the server, acted on later. Never a
  local gate, and never gate on hypervisor detection (VBS).
- Never respond where a tamper is detected. Responses are delayed and decoupled.
- Dev: `loader-dev` takes local bundles signed with a dev key that release builds reject.
- The loader is the first target: it holds the device key, does PKCE/DPoP and starts the module.
  Its handoff and device-key code get integrity-as-key and virtualization like the module's.
- Later:
  - fixups into code immediates;
  - per-user diversified builds (on top of the mutation backend).

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
  build.

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
  - phases 1 to 5 in `research/lab/`, the first C++ lab project. That needs lab C++ config sharing
    (see C++ dialect in `wishlist.md`): a small CMake root that includes `native/cmake/lucent.cmake`
    and links `pe` and `core`, with generated copies of the format and tidy configs;
  - graduation: decoding, semantics and IR into a native library shared with probe; the rewriter
    into `native/tools/`, banned from release presets like `libs/probe`; the runtime (stubs and
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

- The release seed is key material: it drives fact key hashes, the bundle format, the VM
  instruction set, event ids and link order, so a leaked seed undoes that release's rotation.
  Generated per release, stored with the offline release key, never in git. The instruction-set
  description and the event manifest stay server-side, which makes the server's release store a
  target.
- The offline release key lives on hardware (YubiKey or HSM), with a written signing ceremony. A
  stolen release key is the one failure the design can't recover from.
- An internal channel gets fully protected builds, and CI runs the differential tests on protected
  binaries, since VM, mutation and rewriter bugs appear only in release. `products/*.toml` already
  has channels.
- Antivirus false positives: virtualized and mutated code, runtime imports and a manual mapper all
  match antivirus heuristics. The loader gets an EV code-signing certificate, each release goes to
  Microsoft for analysis, and its own protection stays lighter than the module's.
- A response playbook for a crack: a forced release with rotated seeds, revocation and replay
  detection through watermarks and canaries, then delayed bans.
- Metrics: time from a release to its first cracked or replayed sessions, per release. Without it
  there's no telling whether a wall pays for itself.

## Open

- Lab C++ infrastructure first, or the virtualizer straight into `native/tools/` as a dev-only tool.
- Names: the virtualizer project and tool, its runtime library, and the shared decoding and
  semantics library.
- Cooperative bin2bin with a generated C++ interpreter: confirm.
- The VM's performance budget for cold code.
- Events replace the logging API entirely, with no free-text log calls even in dev.
- Which event levels leave the machine in release, and how long they're kept (the platform's
  retention tiers).
- SiMBA and GAMBA as Python dependencies for the red-team tests.
