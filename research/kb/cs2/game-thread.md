---
target: client.dll and engine2.dll (Counter-Strike 2, win64)
last-observed: client.dll cs2 1.41.9.9 (Steam build 2000947, TimeDateStamp 0x6afe3e44); engine2.dll cs2 1.41.9.7 (Steam build 2000943)
status: hypothesis (read offline; not yet confirmed in a running game)
---

# Which thread runs CreateMove, FrameStageNotify and Present

The cs2 module ticks its feature registry from CreateMove and draws it from the present hook. The
registry has one tick thread, so this holds only while all three run on one thread.

- engine2 calls `CSource2Client` slot 15 (CreateMove's builder) and slot 16 (CreateMove itself,
  `jmp [rax+0x40]` into `CCSGOInput` slot 8) from its main loop; old lucent measured both on the
  main thread (its `docs/re/command-send.md` section 4).
- `CSource2Client` slot 36 is FrameStageNotify (client+0xb63350 on 1.41.9.9), called per stage from
  the same loop.
- Present: engine2's `"Present_RenderDevice"` profiler scope sits in `CLoopTypeClientServer`'s slot 8
  (engine2+0x227530 on 1.41.9.7, its vtable at engine2+0x61e0e8), which also names
  `"g_pRenderDevice->Present()"`. A loop type's frame runs on the main thread, so the swap chain is
  presented there too. Old lucent's crash reports tagged a thread "game|render" for the same
  reason: one thread entered both roles.

Not established: whether a launch option or a later build moves presentation to a render thread
(`LaunchAsyncBeginRenderingViewsJob` jobs exist, but they record views; the present is the loop's).

Evidence: the 1.41.9.7 and 1.41.9.9 IDA databases under `re/cs2/`.

To confirm live: record the thread id in the present hook and in the CreateMove hook in a dev build
and compare.
