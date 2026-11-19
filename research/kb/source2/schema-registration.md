---
target: client.dll and schemasystem.dll (Counter-Strike 2, win64)
last-observed: cs2 1.41.9.9 (Steam build 2000947); client.dll TimeDateStamp 0x6afe3e44 SizeOfImage 0x298d000; schemasystem.dll TimeDateStamp 0x6afcfdbb SizeOfImage 0x7f000
status: hypothesis (consistent offline on four builds; not yet checked against a live harvest)
---

# How a Source 2 module registers its schema

A module's class schema (names, sizes, bases, fields with offsets and types) sits in its file as
static records plus the code that finishes them at registration. `engines/source2/probe` reads it
offline (`read_schema`); this page is the picture behind its layout constants.

## Entry and registrars

- `InstallSchemaBindings(const char* version, ISchemaSystem*)` is exported. It compares the version
  with `"SchemaSystem_001"`, stores the `ISchemaSystem*` in a global, then calls the installer
  (client+0x19d3280 on 1.41.9.7).
- The installer walks a list of registrar objects from a head global: for phase 0..3, every
  registrar's first virtual function `(this, ISchemaSystem*, phase, failure*)`. A phase that fails
  999 times is fatal ("unable to register all schema data").
- Each registrar is a static object `{vtable, next}` linked into the head by a static initializer
  of four instructions (`mov rax, [head]; mov [node+8], rax; lea rax, [node]; mov [head], rax`).
  client.dll holds seven: `client`, `animlib`, `compositematerialslib`, `entity2`,
  `mathlib_extended`, `pulse_runtime_lib`, `tier2`. Each schema project linked into the module
  registers itself.
- Phase 0 calls the project's type-table builder: `ISchemaSystem` vtable +0x60 gives the module's
  `CSchemaSystemTypeScope`, whose constructors fill a table of `CSchemaType*` globals.
- Phase 1 calls `ISchemaSystem` +0x100 and +0x108 with lists of declared atomic types and enums.
- Phase 2 calls `ISchemaSystem` +0x110 with `(scope, project name, &table, 118, classes, failure)`;
  `classes` is a null-terminated array of class record pointers in `.rdata`.

## Class record (SchemaClassInfoData_t before registration), 0x80 bytes in `.data`

| offset | what                                |
| ------ | ----------------------------------- |
| 0x08   | name                                |
| 0x20   | size (i32)                          |
| 0x24   | field count (i16)                   |
| 0x28   | alignment (u8; 0xff for unknown)    |
| 0x29   | base count (u8)                     |
| 0x30   | fields                              |
| 0x38   | bases                               |
| 0x50   | type scope, written at registration |
| 0x68   | callback `(phase, record*)`         |

Field (0x20 bytes): name, type, offset (i32), metadata count, metadata. Base (0x10 bytes): offset
(u32), base class record.

The runtime layout source2gen documents differs (size at 0x18): this is the static one.

## Field types

A field's type word before registration is either:

- a tag, `0xf000000000000000 | slot`, naming a slot of the project's type table that phase 0
  fills (m_iHealth: slot 10, the builtin int32); or
- null, and the class's callback writes a `CSchemaType*` there in phase 0, built through the type
  scope: e.g. `C_BaseEntity`'s builds `CGameSceneNode*` as declared-class then pointer.

Bases from other projects or modules (VData and graph controller classes, 12 on 1.41.9.7) are
null in the file; the callback's phase 1 fills in the base's record.

The type scope's constructors, by vtable offset, and how schemasystem.dll names their results
(`CSchemaSystemTypeScope`'s vtable, each slot installing one `CSchemaType_*` RTTI vtable):

| offset | constructor         | arguments after `(this, out)`                        | name                      |
| ------ | ------------------- | ---------------------------------------------------- | ------------------------- |
| 0x28   | builtin             | kind                                                 | `int32`, `float32`, ...   |
| 0x30   | pointer             | type                                                 | `T*`                      |
| 0x38   | atomic              | name, size, alignment                                | name                      |
| 0x40   | atomic of a type    | name, size, alignment, type                          | `N< T >`                  |
| 0x48   | collection          | name, size, alignment, element size, type, fixed, fn | `N< T >`, `N< T, fixed >` |
| 0x50   | atomic of two types | name, size, alignment, type, type                    | `N< T, U >`               |
| 0x58   | atomic of a number  | name, size, alignment, number                        | `N< 10 >`                 |
| 0x60   | declared class      | name                                                 | name                      |
| 0x68   | declared enum       | name                                                 | name                      |
| 0x70   | fixed array         | type, count, element size, alignment                 | `T[n]`                    |
| 0x78   | multi-dim. array    | type, size, alignment, dimensions..., -1             | from the last dimension   |
| 0x80   | bitfield            | bits                                                 | `bitfield:n`              |

Every constructor writes the type to `*out` and returns `out`. Builtin kinds 0..13: Invalid, void,
char, int8, uint8, int16, uint16, int32, uint32, int64, uint64, float32, float64, bool.

## Reading it offline

`read_schema` finds the head through the installer, the registrars through the stores to the
head, and runs the registration code on symbolic values (`src/machine.cpp`): registrars in phases
0 and 2, every class callback in phases 0 and 1, with ISchemaSystem and the type scope modeled
as above. Nothing in the game runs.

## Evidence

- 1.41.9.9 client.dll: 985 classes, 4594 fields, every field typed, no record rejected; every base
  names a listed class, no base is larger than its derived class, and no derived field lies inside
  a base. server.dll of the same build: 1268 classes, 6796 fields, all typed; of the 678 classes
  both modules register, 571 have the same size, and the differences are client/server type
  prefixes and different bases (`C_BaseEntity` against `CBaseEntity`).
- 1.41.9.2, 1.41.9.7, 1.41.9.8 client.dll read the same way; the player-box fields
  (`m_iHealth` 0x34c, `m_pGameSceneNode` 0x330, `m_iTeamNum` 0x3e7, `m_vecAbsOrigin` 0xc8,
  `m_hPlayerPawn` 0x92c, `m_iszPlayerName` 0x6fc) are at the same offsets on all four.
- The fixture `engines/source2/probe/tests/fixtures/schema_game.cpp` registers the same way; its
  test loads it, plays SchemaSystem against it, and gets exactly what the offline reading gets.

## Open

- A live harvest (`engines/source2/harvest`) has to agree with the offline reading on one build
  before the generator relies on it. Until then, in particular unchecked: the multi-dimensional
  array name order (read from schemasystem.dll's code, never observed), and whether
  SchemaSystem reports bitfields at offset 0 as the records hold them.
- The installer's head is found by an instruction pattern over the optimized loop; an
  unoptimized build of the same source doesn't match it (the fixture is built with /O2 for that
  reason). The reader looks for the loop in `InstallSchemaBindings` itself as well as in the
  functions it hands `ISchemaSystem`, since an optimizer may inline the installer; the registrars'
  links may also go through a helper. cs2 does neither on the builds above. The fixture is built
  in all three shapes, and the same in every build configuration.
