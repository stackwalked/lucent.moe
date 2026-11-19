#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

// The release seal (contracts/release-seal/v1): a release's artifacts and their digests, with the
// release's number, signed by the offline code key. Code runs only when this key signed it, so a
// taken-over server can withhold a release but never run its own code. A client accepts only the
// highest number it has seen signed for a product and channel; going back is the old code signed
// again under a new number.

namespace lucent::wire {

// What an artifact is. A module's release has exactly a container and a release manifest; the
// loader's has exactly a loader and a host.
enum class artifact_kind : u8 {
    // The packed container (wire/container.hpp), before the start's encryption.
    container = 1,
    // The release manifest, version 2 (bundle/release_manifest.hpp).
    release_manifest = 2,
    // The loader's executable.
    loader = 3,
    // lucent-host's executable.
    host = 4,
};

struct release_artifact {
    artifact_kind kind = artifact_kind::container;
    // BLAKE2b-256 of the artifact's bytes.
    crypto::digest digest{};

    auto operator==(const release_artifact&) const -> bool = default;
};

struct release_seal {
    // A product id, as ids.hpp describes it.
    std::string product;
    channel chosen = channel::stable;
    // Above every number signed before for this product and channel; never 0.
    u64 number = 0;
    release_id release;
    // The kit::boot_info version: the one a module starts under, or the one a loader hands its
    // modules.
    u32 boot_info_version = 0;
    // Sorted by kind; one of the two sets artifact_kind describes.
    std::vector<release_artifact> artifacts;
    crypto::signature signature{};

    auto operator==(const release_seal&) const -> bool = default;
};

// Everything but the signature, which is what the signature covers.
auto release_seal_signed_bytes(const release_seal& seal) -> std::vector<std::byte>;

auto sign_release_seal(release_seal seal, const crypto::signing_key& code_key) -> release_seal;

auto encode_release_seal(const release_seal& seal) -> std::vector<std::byte>;

// Canonical or nothing: a valid product, a known channel, a non-zero number, one of the two
// artifact sets in kind order, nothing trailing. The signature isn't checked here.
auto decode_release_seal(std::span<const std::byte> bytes) -> result<release_seal>;

// Decodes and checks the signature against the code key, strictly.
auto verify_release_seal(std::span<const std::byte> bytes, const crypto::public_key& code_key)
    -> result<release_seal>;

}
