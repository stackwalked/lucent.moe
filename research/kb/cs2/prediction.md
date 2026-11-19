---
target: client.dll (Counter-Strike 2, win64), client-side prediction and the local player's command run
last-observed: cs2 1.41.9.9 (Steam build 2000947); client.dll TimeDateStamp 0x6afe3e44 SizeOfImage 0x298d000; IDA database re/cs2/1.41.9.9-2000947/db/client.dll.i64
status: mixed, per claim. [verified] means read off this build's code; [hypothesis] means inferred or carried from an older build and not re-read. Nothing here is checked live.
---

# Prediction: saving, restoring and running the local player's command

What M2 (run the command ourselves for several ticks, then put everything back through the game's
own per-entity `SaveData`/`RestoreData`) stands on. Addresses are 1.41.9.9 RVAs on image base
0x180000000. They are there to be found again, not used: the finders are in the last section.

Verdict: M2 is workable on this build, with three conditions the decided design did not have yet:
the game's save must go to storage we own (its own slots must not be touched), it does not cover the
whole movement services object or a few pawn fields (a supplement is needed), and the run must
suppress effects, which nothing does for us outside the game's prediction loop.

## The prediction copy [verified]

The copy is Source 1's datamap prediction copy carried over (`predictioncopy.cpp` asserts,
`PrepareDataMap( %s )`), not schema-driven.

- Each predictable entity has a storage object at `entity+0x5a0` (not in the schema), 0x258 bytes,
  allocated in `InitPredictable` (0x180af3cd0) and built by the storage constructor 0x180518410
  `(storage, datamap)`. It holds the datamap at +0, a packed copy at +8 (the `[orig]` one, the
  networked state), a second packed copy at +0xa0 (used by `NetUpdateStart(nocmds)`), and a vector
  of slot packed copies (count +0x138, items +0x140) with a free list. A packed copy is a
  `CPredictionCopyPackedData` (RTTI vtable 0x181b2b320): a command number at +0x10 (-1 = invalid;
  vtable +0x38 sets it, +0x50 tests it) and a `CUtlBuffer` the copy fills.
- The live side of a copy is `entity+0x2f8`, a `C_BaseEntityOuterHelper` (an `IPredictionCopyable`
  whose +8 returns the entity).
- The datamap comes from entity vtable slot 49 (+0x188). For `C_CSPlayerPawn` it is built at
  runtime by 0x180c4d870 and chains `C_CSPlayerPawnBase` -> `C_BasePlayerPawn` /
  `C_BaseCombatCharacter` -> `CBaseAnimGraph` -> `C_BaseModelEntity` -> `C_BaseEntity`. Entries are
  80 bytes: type u8 +0, name +8, offset +0x10, count u16 +0x14, flags +0x18, embedded map +0x20,
  size +0x28, tolerance f32 +0x2c, ops +0x40.
- Pointers to other objects are followed by `CReferencedFieldPredictionCopyDataOps<T>` entries: the
  pawn map references every pawn service (`m_pMovementServices` as
  `CCSPlayer_MovementServices`, and item, water, camera, weapon, bullet, buy, aim punch). The
  `C_BaseEntity` map has a custom entry `CBodyComponent` (its ops at 0x1821eb718 not followed;
  that they reach the body component's map is hypothesis), and that map references `CGameSceneNode`
  (`m_vecOrigin`, `m_angRotation`, `m_flScale`, `m_flClientLocalScale`); the skeleton and anim graph
  body components have their own maps. So one `SaveData` on the pawn covers the pawn, its services
  and its scene node origin.
- A copy type picks field groups: `copytype` indexes 0x1821f4300 = {1, 2, 3, 0} as a group mask.
  The game's slots use copy type 2 (mask 3, both groups). Use 2.

### `SaveData` 0x180b01040 [verified]

`void SaveData(C_BaseEntity*, const char* reason, int slot, int copytype, int unused, uint32 command, CPredictionCopyPackedData* dest)`

- Returns at once if the entity has no storage.
- If `dest` is null: slot -1 means `[orig]` (storage+8); otherwise slot `n` is fetched with create,
  and creating slot `n` drops every slot above it (0x180524250). If `dest` is given, the slot is
  only text for the log line.
- Sets the destination's command number, builds a `CPredictionCopy` (0x180518140 `(copy, copytype,
  dest, src, 0)`) from `entity+0x2f8` into the packed copy, and runs `TransferData` (0x18052ca80
  `(copy, label, entindex, datamap)`).
- Logs only (`WARNING: Entity %s is saving prediction state from phase %d, instead of
  SERVER_AUTHORITATIVE`) when the local pawn saves `[orig]` outside phase 1. No locks, no thread
  checks, no other side effects.

Callers: `InitPredictable` (orig and every slot), `StorePredictionResults` 0x180be8bb0 (after
each predicted command, into the command's slot, copy type 2, for every entity with
`m_bPredictable` +0x569 set), `NetUpdateStart(nocmds)`, `PostNetworkDataReceived`,
`PostEntityPacketReceived` (orig).

### `RestoreData` 0x180b00e30 [verified]

`void RestoreData(C_BaseEntity*, const char* reason, int slot, int copytype)`

- Source is `[orig]` for slot -1, else slot `n` without create; returns if it is missing or its
  command number is -1. No `dest` parameter: it cannot restore from a copy we own.
- Copies packed -> `entity+0x2f8`, keeps `m_iEFlags` (+0x374) bit 0x8000 as it was before the copy,
  then 0x180225ab0 recomputes the actual move type (+0x526) and pushes it to physics.

Callers: `RestoreEntityToPredictedSlot` 0x180be38e0 (copy type 2, every predictable, then each
entity's vtable +0x428 with the slot) and `NetUpdateStart`.

### Using them from our code

- Never pass a game slot. Saving to slot `n` truncates the game's later slots, and `[orig]` is the
  networked baseline the game diffs against. [verified]
- Proposed: give each entity in the save set its own storage (game constructor 0x180518410 with the
  entity's datamap; destructor 0x180518fb0), swap it into `entity+0x5a0` around one game
  `SaveData(slot k, copytype 2, command = the command's number)` or `RestoreData(slot k, 2)`, and
  swap the game's back. That is the game's code end to end, with our slots. The other way is to
  call the copy constructor and `TransferData` ourselves and repeat `RestoreData`'s two fix-ups.
  [hypothesis: not run]
- Both are synchronous and take no lock; the move data and the copy machinery use statics, so game
  thread only. [verified for the code read; which thread CreateMove runs on is not]

## Running one command [verified unless marked]

The game runs predicted commands in `CPrediction::Update` (vtable slot 11, 0x180be92f0; the
`CPrediction` static is 0x182557440). Per command: `RunSimulation` 0x180be4ed0 copies the command
into the controller's embedded one (+0x610), sets `CPredictionSuppressEffects` to the command's
has-been-predicted byte (+0x8c), sets `m_nSimulationTick` (+0x390) to -1 on every predictable, sets
the controller's current command, then for each predictable entity sets curtime, frametime and
tickcount and calls its simulate (vtable +0x498). The controller's simulate reaches the movement
services slot 32. Afterwards `StorePredictionResults`, then suppression back to 0. Update also sets
`CPrediction+0x34` (in prediction) to 1 for the loop and 0 after, and records the predicted origin
per command for error checking.

### `PlayerRunCommand(services, cmd)` 0x180a6dbc0, movement services slot 32

- Controller from the pawn (`services+0x38` is the pawn; `pawn+0x14bc` `m_hController`).
- Services slot 47 (0x180a71ae0): prediction random seed global (0x1821b7008) = the command's
  seed, prediction player global (0x1823705e8) = controller.
- **Advances the controller's `m_nTickBase` (+0x6b8) by one** unless the current frametime is 0 or
  `cmd+0x94` is 3.
- Saves `CGlobalVars` (pointer 0x182223ad0) +0x30 curtime, +0x34 frametime, +0x44 tickcount, +0x50,
  +0x58 owner thread id; sets curtime = tick base / 64, frametime = 1/64 (0 when paused), owner =
  this thread; restores all five after.
- If `CPrediction+0x34` is set: runs the controller's tick-keyed callback queues (+0x7b0, +0x7d8)
  and marks entries done. Outside the game's loop it is 0, so these do not run for us.
- **Always** (unless mode 3) runs the controller's `RunThinks` 0x18095cb90: component pre-thinks,
  queued string commands due at this tick, `PhysicsRunThink` on the controller, component
  post-thinks.
- `DoMovement`, then services slot 48 (0x1808c7720): seed back to -1, prediction player to null,
  `m_bHasEverProcessedCommand` = 1.

### `DoMovement(services, cmd)` 0x180a6c140

- Globals again (curtime kept, frametime, tickcount from curtime), restored on exit.
- Mode = `cmd+0x94`. Unless 3: copies the button state (+0x58..+0x88, +0x190, +0x1a0..+0x1a8)
  into +0x1e0..+0x220; puts it back at the end.
- A scope on `pawn+0x10e0` (count byte +0x10e1, handle +0x10f4, last tick +0x10f8 written on exit),
  a counter on the physics global 0x18253d760 (+0xc54, flushes deferred work at 0), the moving
  player global 0x182549b78 = pawn, cleared after.
- Unless 3: services slot 50 (base velocity from a moving ground), **pawn +0xa00**,
  `PhysicsRunThink` on the pawn, move data from slot 38 (one static, reset per call), fill it,
  slot 39 `SetupMove`, the subtick loop 0x180a60e40 (slots 42, 40, 33, 44 per step; zeroes +0x198,
  +0x238 = +0x198 after), slot 43 `FinishMove`, 0x180a613d0.
- Slot 30 `UpdateInputState`, a release for each bit of +0x238, slot 31.
- Unless 3: **pawn +0xa08**; `services+0x228` = pawn `v_angle` (+0x13a8); unless mode 2:
  `v_anglePrevious` (+0x13b4) = `v_angle`, `v_angle` = +0x228, **pawn +0xa10**.

### The three pawn virtuals (`C_CSPlayerPawn`)

- **+0xa00** (0x180c87660, slot 320): `CCS2PawnGraphController::ReflectPawnState` (writes anim
  graph parameters, outside the pawn); on the active weapon, 0x180824e90 and 0x180823fd0 (weapon
  timers +0x1a7c..+0x1aa4, and possibly an activity, 802, through 0x1807fe040); pawn slots 323 and
  325 and each pawn component's +0x68; when `CPrediction+0x34` is set, `m_bInBombZone` /
  `m_bInHostageRescueZone` from the touching trigger (+0x3548).
- **+0xa08** (0x180c87380, slot 321): 0x180afe050 (component hook +0x70, pawn slot 324);
  vtable +0x368 on the pawn and its scene children, which reaches the trigger touch code
  0x180967cf0; with `pawn+0x14c5`, weapon calls and 0x180c8bc30; `m_flFlinchStack` decay
  (0x1808cb0a0); `m_flInterpolatedInaccuracy` and its history at +0x1f90 (0x180c930a0).
- **+0xa10** (0x1808c7cc0, slot 322): eye angles (+0x3630) and their history at +0x3640..+0x36a8;
  then the weapon services' tick 0x1808fea70: the active weapon's frame calls (+0xc98, +0xca0,
  +0xca8), a weapon switch through services +0x120 when handedness differs, and
  `CCSPlayerWeaponTimingGraph::RunTick` (a graph at weapon services +0x1290).

So a command run is not movement only: it runs weapon logic (and shooting if the command attacks),
thinks, trigger touches and anim graph updates.

### What has to be set up around a what-if run

| state                                                                                       | who sets it                                   | what M2 does                                                                                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `CGlobalVars` +0x30, +0x34, +0x44, +0x50, +0x58                                             | `PlayerRunCommand` and `DoMovement`, restored | nothing [verified]                                                                                                                  |
| controller `m_nTickBase` +0x6b8                                                             | `PlayerRunCommand`, +1 per run                | let it advance (curtime comes from it); in the save set [verified]                                                                  |
| `CPredictionSuppressEffects` +0x14 (vtable 0x181c36938, slot 0 sets it; object 0x18221f938) | the game's loop only; 0 outside it            | set 1 around the runs, put the old value back [verified that nothing else sets it; that 1 silences sounds and events is hypothesis] |
| random seed, prediction player                                                              | slots 47 / 48                                 | nothing, if -1 / null is their resting value [hypothesis]                                                                           |
| `CPrediction+0x34`, `+0x38`                                                                 | the game's loop                               | leave 0: keeps the controller's tick queues off [verified]                                                                          |
| `m_nSimulationTick` +0x390                                                                  | the game's loop                               | not needed calling slot 32 directly [verified]                                                                                      |
| has-been-predicted (+0x8c), mode (+0x94) of the command                                     | prediction                                    | run a copy of the command, mode 0 [hypothesis: whether the run writes the command is not read]                                      |
| controller's embedded command (+0x610)                                                      | `RunSimulation`                               | untouched if we pass our own copy [verified]                                                                                        |

## The full save set

What a run changes, and whether copy type 2 covers it.

Covered by the game's save [verified from the maps]:

- `C_BaseEntity`: `m_iHealth`, `m_iEFlags`, `m_nWaterType`, `m_flAnimTime`, `m_iTeamNum`,
  `m_fFlags`, `m_vecAbsVelocity`, `m_vecVelocity`, `m_vecBaseVelocity`, `m_hOwnerEntity`,
  `m_MoveCollide`, `m_MoveType`, `m_flWaterLevel`, `m_fEffects`, `m_flFriction`, the gravity
  fields, `m_vecAngVelocity`, and the scene node origin and rotation through `CBodyComponent`.
- `C_BaseModelEntity`: `m_Collision` (the hull), `m_vecViewOffset`. `C_BasePlayerPawn`:
  `m_nNextThinkTick`, `m_hGroundEntity`, the service pointers (followed). `C_CSPlayerPawn`:
  zone flags, `m_bIsWalking`, `m_bIsDefusing`, `m_iShotsFired`, `m_flFlinchStack`,
  `m_flVelocityModifier`, `m_angEyeAngles`, its old-angle arrays, `m_flInterpolatedInaccuracy`, ...
- `CPlayer_MovementServices` (14): `m_nImpulse`, `m_nButtons`, the queued, double-press and toggle
  masks, `m_pButtonPressedCmdNumber[64]`, `m_nLastCommandNumberProcessed`, `m_flCmd*Move`,
  `m_flMaxspeed`, `m_arrForceSubtickMoveWhen`, `m_vecLastMovementImpulses`.
- `CPlayer_MovementServices_Humanoid` (4): `m_flStepSoundTime`, `m_flFallVelocity`,
  `m_flSurfaceFriction`, `m_nStepside`.
- `CCSPlayer_MovementServices` (37): `m_AnimationState`, ground topology, ladder normal, all
  crouch fields but `m_duckUntilOnGround`, `m_nGameCodeHasMovedPlayerAfterCommand`, the grenade
  stash, the friction stash, stamina and jump heights, `m_flAccumulatedJumpError`, `m_LegacyJump`,
  `m_ModernJump`, `m_nLastJump*`, `m_bJumpApexPending`, `m_bWasSurfing`, `m_vecWalkWishVel`,
  `m_bHasEverProcessedCommand`.
- The controller: `m_nTickBase`, `m_nNextThinkTick`, `m_hPawn` and others.

Not covered, and written or read across commands [verified unless marked]:

| object           | range                                                                                                                                                                                                                                                 | why it matters                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| services         | +0x198 (u64), +0x238 (u64)                                                                                                                                                                                                                            | step button mask; +0x238 is read again by a mode-3 run                                        |
| services         | +0x1c0..+0x1cc `m_flForwardMove`/`Left`/`Up`                                                                                                                                                                                                          | FinishMove output; readers not followed                                                       |
| services         | +0x1e0..+0x228                                                                                                                                                                                                                                        | DoMovement's button save area; a mode-3 run restores the buttons from it                      |
| services         | +0x228 (12 bytes)                                                                                                                                                                                                                                     | `v_angle` copy; a mode-3 run writes it to the pawn                                            |
| services         | +0x240 `m_vecOldViewAngles`                                                                                                                                                                                                                           | not in the map                                                                                |
| services         | +0x260 `m_groundNormal`, +0x270 `m_surfaceProps`                                                                                                                                                                                                      | ground state for the next move [hypothesis on readers]                                        |
| services         | +0x404, +0x438, +0x43a..+0x684 (`m_nLadderSurfacePropIndex`, `m_duckUntilOnGround`, `m_bInStuckTest`, stuck and trace state, `m_nTraceCount`, `m_StuckLast`, `m_bSpeedCropped`, `m_nOldWaterLevel`, `m_flWaterEntryTime`, `m_vecForward`/`Left`/`Up`) | stuck test and water entry carry over                                                         |
| services         | +0x710 `m_flTicksSinceLastSurfingDetected`, +0x718..+0x7a4, +0x7b0..+0xfd0 (unnamed)                                                                                                                                                                  | which of it a run writes is not settled [hypothesis]                                          |
| pawn             | +0x13b4 `v_anglePrevious`                                                                                                                                                                                                                             | DoMovement shifts it every run                                                                |
| pawn             | +0x3640..+0x36a8 eye angle history, +0x1f90 inaccuracy history                                                                                                                                                                                        | written by +0xa10 / +0xa08 [hypothesis: interpolation history]                                |
| pawn             | +0x10e0 scope (+0x10f8 last tick)                                                                                                                                                                                                                     | DoMovement writes the tick on exit [hypothesis on what reads it]                              |
| pawn             | +0x328 `m_nLastThinkTick`, think contexts at +0x398                                                                                                                                                                                                   | `PhysicsRunThink` [hypothesis]                                                                |
| outside the pawn | anim graph parameters, the weapon timing graph, trigger touch lists                                                                                                                                                                                   | not entity bytes; the game's own repredicts rewrite them, so likely self-healing [hypothesis] |

The services object is 0xfe0 bytes (schema), `CPlayer_MovementServices` 0x258, `_Humanoid` 0x288.
The game's map covers well under half of its bytes. So M2 is the game's `SaveData`/`RestoreData`
for every entity in the set **plus** a byte copy of the uncovered ranges above (with no pointers in
them: services +0x0..+0x48 holds the vtable, chain entity, graph controller and pawn pointer and is
left alone).

Volatile (expected to differ after restore, not restored) [hypothesis, to be confirmed by the
probe]: the scene node's cached absolute transform and dirty bits (rebuilt from `m_vecOrigin`),
the interpolation latch dirty flags (`C_BaseEntity` +0x3c0) the change notifications set, and the
prediction storage itself.

The entity set: the game saves every entity in the local context's predictable list
(`CPrediction+0x58` contexts of 0xb8 bytes, count +0x50; context +0x18 controller, +0x48 count,
+0x50 entities). M2 should save the same list: at least the pawn, the controller (tick base) and
the active weapon (+0xa00 and +0xa10 change it), and any weapon a switch reaches. [verified for
the list's shape; which entities are in it live is not]

## Finders

- **`SaveData`**: the only function referencing `"SaveData   :%32.32s [orig]"` (also has
  `"... [%4d]"`). Cross-check: it loads `[rcx+5A0h]`, calls `[rax+188h]` on the entity, and calls
  the same two functions as `RestoreData` (below).
- **`RestoreData`**: the only reference to `"RestoreData:%32.32s [orig]"`. Consensus with
  `SaveData`: both call one copy constructor (the function holding `"CPredictionCopy::Init must
  have pDest!"`) and one `TransferData` (holding `"CPredictionCopy::TransferData:  tried to
  TRANSFERDATA_COPYONLY"`), and both pass `entity+X` as the live side: X is the outer helper
  offset (0x2f8), and the first load in `RestoreData` is the storage offset (0x5a0).
- **Storage size and constructor**: in the function referencing `"InitPredictable"` (and
  `":    initpredictable %d:%s for %d slots"`), the `operator new` argument (0x258) and the call
  after it whose result is stored at the storage offset. The constructor writes the
  `CPredictionCopyPackedData` RTTI vtable twice (+8 and +0xa0); the destructor is the call before
  the matching `operator delete(p, 0x258)`.
- **Datamap slot**: the displacement of the entity virtual call in `SaveData` (+0x188). Check that
  `C_CSPlayerPawn`'s slot returns a static whose builder writes the string `"C_CSPlayerPawn"`.
- **Copy type 2**: the constant `StorePredictionResults` (the function referencing
  `"StorePredictionResults"`) passes as the fourth argument of `SaveData`.
- **`PlayerRunCommand`**: the only reference to `"runcommand:%04d,tick:%u"`; the same function
  must sit (directly or through a one-jump thunk) in slot 32 of the RTTI vtable
  `CCSPlayer_MovementServices`. **`DoMovement`**: the only reference to
  `"CPlayer_MovementServices->DoMovement()"`, called once from `PlayerRunCommand`.
- **Pawn virtuals**: in `DoMovement`, the three `call [rax+disp]` on the pawn (`[services+0x38]`),
  in order; read the displacements and check them in the RTTI vtable `C_CSPlayerPawn`.
- **`CGlobalVars`**: the global pointer `PlayerRunCommand` reads +0x30/+0x34/+0x44 from before
  `DoMovement` and writes back after; must equal the one `DoMovement` uses.
- **Tick base**: the field `PlayerRunCommand` increments on the controller; must equal schema
  `CBasePlayerController::m_nTickBase` (0x6b8).
- **`CPredictionSuppressEffects`**: the RTTI type gives the vtable; its slot 0 is a one-store
  setter (byte at +0x14). The object is the global pointer `RunSimulation` calls slot 0 through
  twice (the function referencing `"RunSimulation cmd %d -> slot %d"` calls `RunSimulation`).
- **`CPrediction`**: RTTI vtable `CPrediction`, slot 11 references `"CPrediction::Update"`; the
  static is what its only constructor call is given. In-prediction is the byte Update sets to 1
  before `"[t%d f%d] server snapshot %d last exec cmd %d, predicting %d commands %d..%d"` and to 0
  after; `PlayerRunCommand`'s gate reads the same byte. The predictable list: the context array
  Update walks before `"Remote player slot %d has no last executed command"`.
- **Datamap fields**: walk the map at runtime (entries 80 bytes, base at +0x18 of the map header)
  rather than hard-coding the lists above; the uncovered ranges are schema fields of the services
  classes minus map entries, plus the unnamed ranges, recomputed per build.

## Risks and what needs a live check

- **Effects.** Outside the game's loop suppression is off, so a what-if run would play footsteps,
  land and jump sounds, weapon sounds and events unless we set it. Live: run a what-if while
  walking, with and without the flag, and listen.
- **Weapon logic runs.** +0xa10 ticks the active weapon (frames, possible switch, timing graph).
  A command with attack held in a what-if fires a predicted shot (suppressed effects, restored
  state) or worse. Live: what-if with attack and with a pending switch; compare weapon and weapon
  services bytes after restore. A narrower run (calling `DoMovement` with our own tick base and
  globals, like `PlayerRunCommand` does) skips the controller's thinks and the tick base write but
  not the pawn virtuals; deciding between the two is for the owner.
- **Controller thinks.** `PlayerRunCommand` runs the controller's `RunThinks` and queued string
  commands on every run. Whether anything is due during a what-if is live-only.
- **Re-entrancy.** Our runs must happen when `CPrediction+0x34` is 0 (not inside `Update`). If
  CreateMove can run inside `ClientSidePredict` or on another thread, the globals owner field and
  the static move data race. Live: log `CPrediction+0x34` and the thread id at the movement stage.
- **Residue into the game's prediction.** The game restores from its slots before predicting, which
  fixes mapped fields only; anything in the uncovered table we leave changed goes into the next
  real prediction and then to the server's view of us. The dev probe (bytes equal after any
  what-ifs, minus a declared volatile list) is the check, over pawn, services (all 0xfe0), the
  controller, the active weapon and weapon services.
- **Interpolation.** Change notifications during the run set latch dirty flags; if a latch happens
  between run and restore (it should not inside CreateMove), the rendered pawn jumps. Live: watch
  for a visible stutter with what-ifs on.
- **Subtick.** The run reads the command's subtick moves (`m_arrForceSubtickMoveWhen` and the
  protobuf steps). A what-if command must carry the steps M2 means to test, and whether the run
  writes into the command is not read; run on a copy.
- **Mode 3 commands.** Prediction marks some re-run commands mode 3, which skips the move and reads
  the services' save area; those are why the save area is in the supplement.

## Evidence

- 1.41.9.9 client.dll, IDA database `re/cs2/1.41.9.9-2000947/db/client.dll.i64` (made for this
  page from the installed file, SHA-256 9e0fd6aa...67ee, same as `bin/client.dll`). Every address
  above is from it.
- 1.41.9.7 client.dll, `re/cs2/1.41.9.7-2000943/db/client.i64`: `SaveData` 0x180b005a0 and
  `RestoreData` 0x180b00390 have the same code as on 1.41.9.9 (old lucent's notes had these right).
- Old lucent `docs/re/prediction.md` (read on 1.41.8.3): services slots 32, 33, 38, 39, 43, the
  0xfe0 size and the DoMovement save area agree with this build. Its pawn virtuals (+0xa00, +0xa08,
  +0xa10) are followed here for the first time.

## Open

- The dev probe has not been built, so every "not covered" row is a reading, and the volatile list
  is a guess.
- Who reads `m_flForwardMove`, `m_groundNormal`, `m_surfaceProps` and the large unnamed services
  ranges, and whether any of them hold pointers.
- Whether running the command mutates the command object.
- The storage swap is designed, not run.
