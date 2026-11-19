---
target: client.dll (Counter-Strike 2, win64)
last-observed: cs2 1.41.9.9 (Steam build 2000947); client.dll TimeDateStamp 0x6afe3e44 SizeOfImage 0x298d000
status: hypothesis (read offline and resolved by the generator; not yet written in a running game by this repo)
---

# The user command, as the command domain reaches it

What `targets/cs2/domains` reads and writes at CreateMove, and why the facts behind it are found
the way `targets/cs2/finders/src/command.cpp` and `input.cpp` find them. Old lucent's
`docs/re/subtick.md` and `docs/re/command-send.md` measured the behaviour; this page is the layout
on the current build.

## Reaching the command

- `CCSGOInput` (RTTI `.?AVCCSGOInput@@`, vtable client+0x1c97330) is held by one global
  (client+0x2230210). `CSource2Client` slot 16 is a thunk `mov rcx, [input]; mov rax, [rcx];
  jmp [rax+0x40]`: CreateMove is `CCSGOInput` slot 8 (client+0xce1d00).
- Slot 8 calls the base CreateMove (client+0xb625d0, split into three .pdata parts), then resets a
  byte, a qword of -1 and three dwords of the input. The base takes the slot's controller
  (GetLocalPlayerController, the same table as the `local_player_controller` fact), its newest
  sequence (client+0x93d700) and the command at that sequence (GetUserCmd, client+0x9404b0: a ring
  of 150 commands of 0x98 bytes, each holding its sequence at +8).
- Slot 5 (client+0xb5ba30) builds the command earlier in the frame; slot 8 finishes it. A write at
  slot 8 is what the client's movement and a synchronous send see; JIT async send (remote servers)
  sends earlier copies (old lucent `docs/re/command-send.md` 4-5).

## CUserCmd and its messages

- `CUserCmd` embeds a `CSGOUserCmdPB` at +0x10 (has-bits at +0x20); its base command
  (`CBaseUserCmdPB*`) is at +0x40, its own `CInButtonState` words (held, changed, scroll) at
  +0x60/+0x68/+0x70. The client's movement reads these words; the builder copies them into the
  base command's `CInButtonStatePB` (+0x18/+0x20/+0x28, has-bits 1/2/4) each tick.
- `CBaseUserCmdPB` (has-bits at +0x10): `buttons_pb` (field 3, bit 2) at +0x38, `viewangles`
  (field 4, bit 4) at +0x40, `forwardmove`/`leftmove` at +0x58/+0x5c (bits 0x40/0x80),
  `mousedx`/`mousedy` (fields 11/12, bits 12/13) at +0x70/+0x74, `subtick_moves` (field 18, a
  repeated message) at +0x18.
- `CSubtickMoveStep` (0x38 bytes, has-bits at +0x10): button (field 1, bit 1) +0x18, pressed
  (2, bit 2) +0x20, when (3, bit 4) +0x24, analog forward/left deltas (4/5, bits 8/0x10)
  +0x28/+0x2c, pitch/yaw deltas (8/9, bits 0x20/0x40) +0x30/+0x34.
- The repeated field is protobuf's `RepeatedPtrFieldBase`: arena +0, live count +8, capacity +0xc,
  rep +0x10; the rep holds its constructed-element count at +0 and the element pointers from +8.
  Elements past the live count are cleared and reused by the next Add. A new element comes from
  `CSubtickMoveStep::New(arena)` (client+0x4f5700, the one function naming the class's RTTI type
  descriptor) and goes in through `AddAllocated` (client+0x122ef80), as the base command's own
  parser does for field 18 (client+0x4f3d50).

## How the fields are found

A generated serializer tests a field's has-bit, loads the field and writes its wire tag
(`(number << 3) | wire type`), so each field is matched in its class's serializer (picked by RTTI)
as bit test, load, tag. A field renumbered, retyped, or given another bit fails its finder.

## The view angles

The input's view angle getter (client+0xb66ef0) and setter (client+0xb76e40) are leaves without
unwind data: for slot 0, the last pending input sample's angles (count +0xb50, array +0xb58,
0x440-byte samples, angles at +0x430) while there are samples, else the resting angles at +0x688.
The generator refuses a method fact without a .pdata start, so the view domain writes the place
the setter would, found from both functions' code.

The game's mouse conversion (client+0xb9ceb0) is the one function reading both the `sensitivity`
and `m_yaw` convars: `(slot, y counts, x counts, scale, pitch out, yaw out, scaled x, scaled y)`.
Yaw is `-(m_yaw * sensitivity * scale * x)`; pitch is `sensitivity_y_scale * sensitivity * scale *
y` times m_pitch when sv_cheats allows, else 0.022 with m_pitch's sign. Its caller (+0xb9c790)
multiplies the scale by the local pawn's zoom adjustment (pawn +0x149c) first and inverts pitch
for `mouse_inverty` after.
