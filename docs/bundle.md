# bundle

The public API is `native/libs/bundle/include/lucent/bundle/fact_set.hpp` (signing a set) and
`native/libs/bundle/include/lucent/bundle/bundle.hpp` (delivering, encoding, verifying a subset).
The wire format is pinned by the golden vectors in `contracts/fact-bundle/v1/`.

## Invariants across files

- The encoding is canonical: decoding accepts only what encoding would write byte for byte.
  The fuzz targets in `native/libs/bundle/fuzz/` assert the round trip.
- Decoder input is untrusted; the bounds in `native/libs/bundle/src/format.hpp` and the reader in
  `native/libs/bundle/src/wire.hpp` are the only reads of it.
- Proof generation and root reconstruction in `native/libs/bundle/src/merkle.cpp` consume hashes
  in the same order; changing one changes the other.
- `verify` checks signature and proof only. Whether a set fits the loaded modules is decided
  elsewhere.
- A changed golden vector is a changed wire format.
