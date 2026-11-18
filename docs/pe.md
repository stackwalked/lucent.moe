# pe

Start at `pe::image_view::parse` in `native/libs/pe/include/lucent/pe/image_view.hpp`; each data
directory is a free function over an `image_view`, one header each, beside it.

## Invariants across files

- Input is untrusted. Bad input is `error_code::malformed` or `unsupported`, never a crash or an
  outsized allocation: counts are checked against the bytes present before anything is sized from
  them, and `SizeOfImage` is bounded because `to_mapped_layout` allocates that much.
- Results are values in RVAs, not pointers into the input; only the spans the view hands out
  borrow it.
- On-disk structures are read only through the bounds-checked copies in
  `native/libs/pe/src/format.hpp`. Nothing in `native/libs/pe/src/` includes Win32.
- Behavior is pinned by `native/libs/pe/tests/` (corruption and real loaded images) and the
  libFuzzer targets in `native/libs/pe/fuzz/`.
