# bundle

The fact bundle format: a fact set (game facts keyed by module builds) signed by the generator, and a bundle that carries a chosen subset of its entries with a Merkle multiproof. It is written for three holders, none of which uses it yet: the generator signs sets, the server delivers subsets, the in-game module decodes and verifies them.

## Where things are

- Public API, one header per concern under `native/libs/bundle/include/lucent/bundle/`.
  - `fact_set.hpp`: the data model (`fact_set`, `fact_set_header`, `entry`, `module_key`), `sign_fact_set`, `signed_bytes`, `manifest_digest`.
  - `bundle.hpp`: the delivery side (`delivered_set`, `deliver`, `deliver_all`), `encode_bundle`, `decode_bundle`, `verify`.
- Private, under `native/libs/bundle/src/`.
  - `format.hpp`: magic numbers, `format_version`, decoder bounds.
  - `wire.hpp`: little-endian `writer` and `reader`.
  - `merkle.hpp` / `merkle.cpp`: `leaf_hash`, `tree_root`, `proof_for`, `root_from`.
  - `bundle.cpp`, `fact_set.cpp`: the public functions above.
- The wire format's golden vectors live outside the project, in `contracts/fact-bundle/v1/`.

## Flow

- Generator side: `sign_fact_set` sorts the entries, computes the Merkle root over `leaf_hash` of each, and signs `signed_bytes` of the header.
- Server side: `deliver` picks entries by key and asks `proof_for` for the sibling hashes a holder of only those leaves needs; `encode_bundle` writes one or more `delivered_set`.
- Module side: `decode_bundle` parses, then `verify` checks the signature against trusted keys and rebuilds the root with `root_from` from the delivered leaves plus `proof`.
- `proof_for` and `root_from` must consume hashes in the same order; change one and you change the other.

## Invariants across files

- The format is canonical: `decode_bundle` accepts only what `encode_bundle` would write byte for byte, so a successful decode re-encodes to its input. `native/libs/bundle/fuzz/decode.cpp` asserts this.
- Decoding input is untrusted: bounds in `format.hpp` and the `reader` in `wire.hpp` are the only reads of input bytes.
- `verify` does not decide whether a set fits the loaded modules or the linked manifest; its header comment names `resolve` as the step that does, and no `resolve` exists in this project.
- Leaf and interior hashes are domain-separated in `merkle.hpp`; do not hash entries any other way.
- Version policy: a non-additive format change bumps `format_version` (see `format.hpp`); an unknown version decodes as `version_mismatch`.
- Signing and hashing go through `lucent::crypto`; this library holds no key material.

## Where behavior is pinned

- `native/libs/bundle/tests/bundle_test.cpp`: tree roots against a reference, every-subset proofs, tamper cases, encode/decode round trip, malformed encodings. Shared builders in `native/libs/bundle/tests/fixtures.hpp`.
- `native/libs/bundle/tests/vectors_test.cpp`: the encoder must reproduce `contracts/fact-bundle/v1/` exactly and the decoder read it back. `moon run bundle:vectors` (see `moon.yml`) rewrites the vectors; a changed vector is a changed wire format.
- `native/libs/bundle/fuzz/decode.cpp` and `native/libs/bundle/fuzz/verify.cpp`: libFuzzer targets, seeded from the vectors. `verify.cpp` re-signs decoded sets so mutated headers still reach the proof check.

## Not here

Ed25519 and BLAKE2b are in `native/libs/crypto`.
