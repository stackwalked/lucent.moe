---
target: coreclr.dll (CoreCLR, win-x64)
last-observed: 10.0.12 (osu!lazer 2026.1005.0, self-contained); 10.0.11 (shared runtime); 8.0.30
status: verified
---

# The CoreCLR contract descriptor

CoreCLR 10 exports `DotNetRuntimeContractDescriptor`, a data descriptor written for the
out-of-process debugger reader (cDAC). It names the runtime's types, field offsets and globals for
the exact build it ships in, so a reader needs no per-build layout mirror for what it covers.

## Presence

| coreclr.dll                 | export  |
| --------------------------- | ------- |
| 8.0.30                      | absent  |
| 10.0.11                     | present |
| 10.0.12 (lazer 2026.1005.0) | present |

9.x was not observed: no 9 runtime is installed here.

osu!lazer 2026.1005.0 ships self-contained on `net10.0` / Microsoft.NETCore.App 10.0.12
(`osu!.runtimeconfig.json`), so lazer has the descriptor.

## Shape (as read from 10.0.11 and 10.0.12)

The export is a struct in `.data`:

| offset | field                                 |
| ------ | ------------------------------------- |
| 0      | `u64` magic, `"DNCCDAC\0"`            |
| 8      | `u32` flags (1)                       |
| 12     | `u32` descriptor size (10826)         |
| 16     | pointer to the descriptor, UTF-8 JSON |
| 24     | `u32` pointer-data count (25)         |
| 32     | pointer to the pointer-data array     |

The JSON has `version` (0), `baseline` (empty), `types`, `globals` and `contracts`. Types map
field names to byte offsets (`"!"` is the size). A global is either a literal or `[[i], "pointer"]`,
an index into the pointer-data array, whose entries are absolute addresses relocated by the loader.
Read on disk they carry the image's preferred base; read in a live process they are real addresses.

10.0.11 and 10.0.12 have identical types and globals.

## What it covers for reaching static fields

The path from the runtime's roots to a type's statics is described end to end:

- globals `AppDomain` and `SystemDomain` (pointers);
- `AppDomain`: `DomainAssemblyList` (an `ArrayListBase`: `Count`, `FirstBlock`), `RootAssembly`;
- `Assembly.Module`; `Module`: `TypeDefToMethodTableMap` (a `ModuleLookupMap`), `Path`, `FileName`, `Base`;
- `MethodTable`: `AuxiliaryData`, `EEClassOrCanonMT`, `Module`, `ParentMethodTable`;
- `DynamicStaticsInfo`: `GCStatics`, `NonGCStatics`, with the global `StaticsPointerMask`;
- thread statics: `ThreadLocalData`, `ThreadStaticsInfo`, `TLSIndex`, global `TlsIndexBase`.

Not covered: `FieldDesc`. No type in the descriptor names a field's offset within its statics
block or object, so field offsets still come from the layout harvest.

How to walk these (the tag bits in `ModuleLookupMap` entries, what `StaticsPointerMask` strips,
where `DynamicStaticsInfo` sits relative to `MethodTable`) is not data. It lives in the versioned
contract algorithms (`Loader` 1, `RuntimeTypeSystem` 1) documented in dotnet/runtime
`docs/design/datacontracts/`. The descriptor's `contracts` map gives the version to follow.

## Method

`llvm-readobj --coff-exports coreclr.dll` for presence. A `pefile` script maps the export's RVA,
reads the header above, and decodes the JSON at the descriptor pointer. Nothing ran in a live process.
