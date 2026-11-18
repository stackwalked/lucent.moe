# probe

Reads a game module's file from disk and answers the questions a finder asks before it hooks
anything: where a string is used, which vtables a class has, who calls a function. It is the
base of the fact generator; no other project depends on it yet.

## Where things are

- `native/libs/probe/include/lucent/probe/module_file.hpp`: `module_file`, the entry point. Everything else takes one.
  `module_file::load` lays raw file bytes out by RVA; accessors return `std::optional` for out-of-image reads.
- Anchors, the places a finder starts from:
  - `native/libs/probe/include/lucent/probe/strings.hpp`: `string_rvas`, stored text in data sections.
  - `native/libs/probe/include/lucent/probe/rtti.hpp`: `rtti_vtables_of`, a class name to its `rtti_vtable`s.
  - `native/libs/probe/include/lucent/probe/byte_pattern.hpp`: `byte_pattern` and `pattern_rvas`, the fallback when nothing above anchors.
- `native/libs/probe/include/lucent/probe/code_index.hpp`: `code_index::build` decodes the executable sections (Zydis) into `reference`s;
  `references_to` answers "who uses this target". `references_in` decodes one range on demand.
- `native/libs/probe/include/lucent/probe/navigation.hpp`: `reference_at` follows one instruction, `vtable_functions` lists a vtable's slots.
- `native/libs/probe/src/ranges.hpp`: private `detail::code_sections` / `data_sections`, shared by the scanners.

## How it flows

A finder loads a `module_file`, finds an anchor (string, RTTI, or pattern) as an RVA, then uses
`code_index` to find the instructions that reference it, and `reference_at` / `vtable_functions` to
move from there to the function it wants. Everything is RVAs into one module; there is no
process or address-space state.

## Invariants across files

- The module is never relocated. RVAs index it directly, absolute addresses inside it are relative to
  the preferred base, and `module_file::rva_of` converts one to an RVA.
- Input is a game binary and therefore untrusted. Reads return `std::optional` or empty, not
  failure; walks are bounded (`max_vtable_slots` and `max_instruction_size` in
  `native/libs/probe/src/navigation.cpp`, `byte_pattern::max_size`).
- Results are candidates, not proofs. The linear sweep in `code_index` can read data placed among
  code as instructions.
- `module_file` owns its bytes and its view points into them, so it is move-only.
- `byte_pattern` is `consteval`: a malformed pattern is a compile error.

## Where behavior is pinned

- `native/libs/probe/tests/anchors_test.cpp`: strings, RTTI vtables (including multiple bases), patterns.
- `native/libs/probe/tests/code_index_test.cpp`: the index against decoding single ranges.
- `native/libs/probe/tests/module_file_test.cpp`: file-to-function mapping and base-relative addresses.
- `native/libs/probe/tests/fixtures/game.cpp` is built as a DLL with RTTI by `lucent_fixture`
  (`native/cmake/lucent.cmake`). `native/libs/probe/tests/images.hpp` loads that DLL into the test
  process, so the probe's reading of the file is checked against what the loaded objects really hold.

## Not here

PE parsing (`image_view`, `runtime_function`) is in `native/libs/pe`.
