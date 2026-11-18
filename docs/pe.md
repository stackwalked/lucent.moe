# pe

Parser for 64-bit Windows PE images (PE32+ only), from a file on disk or from a module read out of another process's memory. It reads bytes it does not control and hands back copied-out values; it never maps, relocates or executes anything. Users: `native/libs/manualmap` (mapping), `native/libs/probe` (module files, code and string indexes), `native/kit` (fact resolution, releases) and `native/tools/loader-dev`.

## Where to start

- `native/libs/pe/include/lucent/pe/image_view.hpp`: the core. `pe::image_view::parse` validates headers and sections and is the only way in; `pe::layout` says whether the bytes are a file or a loader-mapped image. `to_mapped_layout` builds the loader's layout from a file image.
- One header per directory, each a free function taking an `image_view`:
  - `exports.hpp`: `pe::export_table` (lookup by name or ordinal, forwarders as `pe::forwarder`).
  - `imports.hpp`: `pe::imports_of`.
  - `relocations.hpp`: `pe::relocations_of`.
  - `runtime_functions.hpp`: `pe::runtime_functions_of`, the exception table.
  - `tls.hpp`: `pe::tls_of`.
- `native/libs/pe/src/format.hpp`: private mirrors of the on-disk structures and constants. Everything else in `src/` is one translation unit per public header.

## Flow

Callers parse once, then pass the same `image_view` to the directory functions. Each of those looks the directory up with `find_directory`, reads it through `bytes_at` / `string_at` / `contents_of`, and returns plain values in RVAs (offsets from the image base), not pointers. A directory the image lacks is empty or absent, per the header's contract.

## Invariants across files

- The input span is borrowed: the `image_view` must not outlive the bytes, but nothing it returns points into them except the spans from `headers`, `contents_of` and `bytes_at`.
- Bad input is an error, never a crash or an outsized allocation: `error_code::malformed`, or `unsupported` for other machines and PE32. Counts are checked against the bytes actually present before anything is sized from them.
- `parse` bounds `SizeOfImage` (see the commit that added the check for the measurements behind it), because `to_mapped_layout` allocates that much.
- Header structures are read through `detail::read_at` in `format.hpp`, which bounds-checks and copies.
- The tests use `native/libs/os` only as a file loader (development-scoped dependency). Nothing under `src/` includes Win32 headers.

## Where behavior is pinned

- `native/libs/pe/tests/corruption_test.cpp`: malformed and unsupported inputs, the size limits, and seeded random corruption.
- `native/libs/pe/tests/image_view_test.cpp`: parsing against real loaded images, with exports compared to `GetProcAddress` and the file compared to its loaded copy. Helpers in `native/libs/pe/tests/images.hpp`.
- `native/libs/pe/fuzz/`: one libFuzzer target per parser, each defining `lucent::fuzzing::run_one`. `native/libs/pe/fuzz/image_view.cpp` checks every returned span lies inside the input. Built only under the fuzz preset.
