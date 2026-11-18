# kit

The runtime library every injected module shares: it gets a module started, attached to a target, kept
in contact with its host, and freed again. Targets (`native/targets/cs2`) plug into it; the dev host
(`native/tools/loader-dev`) speaks its wire formats from the other side of the process boundary.

## Where things are

Public headers are in `native/kit/include/lucent/kit/`; sources and private headers in `native/kit/src/`.

- Lifecycle
  - `native/kit/include/lucent/kit/lifecycle.hpp`: `start()` is the one entry a module calls; a target supplies an `attach_fn`
    returning an `attachment`, whose `detach()` is the unload hook.
  - `native/kit/src/lifecycle.cpp`: the lifecycle thread and its stage sequence.
  - `native/kit/src/release.cpp`: `release_module`, the module freeing itself, one path per `image_kind`.
  - `native/kit/src/unmap_stub.hpp`: the machine-code stub a mapped module ends in.
- Host channel
  - `native/kit/include/lucent/kit/boot_info.hpp`: `boot_info`, the handshake struct the host writes into the target.
  - `native/kit/include/lucent/kit/session.hpp`: `session`, two one-way pipes.
  - `native/kit/include/lucent/kit/session_message.hpp`: `session_message`, `encode` and `decode` of the framed wire format.
- Hooks
  - `native/kit/include/lucent/kit/hook.hpp`: `hook_slot` (one detour site), `hook_on`, `hook_set` (install and remove together).
  - `native/kit/src/hook.cpp`: install over safetyhook, and the drain-and-freeze removal.
- Facts
  - `native/kit/include/lucent/kit/fact.hpp`: `fact_record`, the typed kinds in `fact::`, and `LUCENT_FACT`.
  - `native/kit/src/fact_section.cpp`: the section markers behind `linked_fact_records()`.
  - `native/kit/include/lucent/kit/fact_resolve.hpp`: `resolve()` checks delivered values against a loaded `module_image`;
    `capability` is what a feature requires.

## How it flows

The host fills a `boot_info` and runs the module's boot export, which calls `start()`. That creates the
lifecycle thread and returns. The thread reports each `stage` over the `session`, calls the target's
`attach_fn`, and blocks in the run stage until `unload_request` arrives or the channel closes. Then it
runs `detach()` and, if that succeeded, `release_module`. The host side is
`native/tools/loader-dev/src/session/` and `native/tools/loader-dev/src/inject/`.

Facts are separate from that path. A fact declared with `LUCENT_FACT` lands in the `.lfact` section;
`resolve()` writes delivered `fact_value`s into those records and sets each
record's status. Code reads a fact through its typed class, and a feature gates on a `capability`.

## Invariants across files

- The module must never be freed while any thread might still run its code. `hook_set::remove`
  returns `timed_out` rather than free trampolines early, a failed `detach()` makes `run()` return
  false, and the lifecycle thread then leaks on purpose instead of calling `release_module`.
- The lifecycle thread is a raw `CreateThread`, not a kit worker, because it ends by freeing its own
  module. Hooks are installed and removed on that thread only; safetyhook is built without
  thread-safe statics (the reason is in the git log for `native/kit`).
- A mapped module has no static TLS, so nothing in kit may need it.
- `boot_info` and `unmap_args` cross binaries or hand-written machine code; their layouts are pinned by
  `static_assert`, and `boot_info_version` also versions the session protocol.
- Foreign memory (the loaded game image, vtables, headers) is read only under `contain()`. Resolved
  values are untrusted until their kind's check passes; a fact that fails keeps no value, and reading
  an unresolved fact is an invariant violation, not a runtime error.
- Fact keys are hashes (`fact_key`), so names never reach the binary. The section's records must tile
  with no padding (`fact_record` is size-asserted) and key 0 means a gap.
- Frame size is bounded (`max_frame_size`) before any allocation.

## Where behavior is pinned

Tests are in `native/kit/tests/`, registered in `native/kit/CMakeLists.txt`.

- `native/kit/tests/fact_resolve_test.cpp`: each kind's accept and reject cases, against the test binary's own image.
- `native/kit/tests/fact_section_test.cpp` with `native/kit/tests/fact_section_other.cpp`: facts fold across translation units and
  enumerate exactly once.
- `native/kit/tests/hook_test.cpp`: install atomicity, removal waiting for in-flight calls and for uncounted threads,
  and giving up after its patience.
- `native/kit/tests/session_message_test.cpp`: encode and decode round trip, frame bounds, malformed bodies.
- `native/kit/tests/unmap_stub_test.cpp`: runs `unmap_stub_bytes`; `native/kit/tests/unmap_stub.s` is the assembly they were taken from.

No test names `native/kit/src/lifecycle.cpp`, `native/kit/src/release.cpp` or `native/kit/src/session.cpp` as its unit.

## Not here

Process injection and mapping live in `native/tools/loader-dev`, Win32 wrappers in `native/libs/os`; kit holds the module-side half. Game-specific facts and hooks belong to the targets.
