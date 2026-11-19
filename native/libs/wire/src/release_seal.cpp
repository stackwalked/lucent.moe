#include <lucent/wire/release_seal.hpp>

#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1:
//   context "lucent release seal v1" (32), u8 product size, product, u8 channel, u64 number,
//   release id (16), u32 boot_info version, u8 artifact count, per artifact: u8 kind,
//   digest (32); then the code key's Ed25519 signature (64) over everything before it.

namespace lucent::wire {
namespace {

constexpr u32 version = 1;
constexpr usize artifact_size = 1 + crypto::digest_size;

auto is_known(channel chosen) -> bool {
    switch (chosen) {
    case channel::stable:
    case channel::alpha:
    case channel::debug:
        return true;
    }
    return false;
}

auto kinds_of(const release_seal& seal) -> std::vector<artifact_kind> {
    std::vector<artifact_kind> kinds;
    kinds.reserve(seal.artifacts.size());
    for (const release_artifact& artifact : seal.artifacts) {
        kinds.push_back(artifact.kind);
    }
    return kinds;
}

auto is_known_set(const std::vector<artifact_kind>& kinds) -> bool {
    const std::vector<artifact_kind> module{
        artifact_kind::container,
        artifact_kind::release_manifest,
    };
    const std::vector<artifact_kind> loader{artifact_kind::loader, artifact_kind::host};
    return kinds == module || kinds == loader;
}

auto is_canonical(const release_seal& seal) -> bool {
    return is_known(seal.chosen) && seal.number != 0 && is_known_set(kinds_of(seal));
}

auto write_signed(detail::writer& out, const release_seal& seal) -> void {
    out.write_context("release seal", version);
    out.write_product(seal.product);
    out.write_u8(std::to_underlying(seal.chosen));
    out.write_u64(seal.number);
    out.write_bytes(seal.release.bytes);
    out.write_u32(seal.boot_info_version);
    out.write_u8(narrow<u8>(seal.artifacts.size()));
    for (const release_artifact& artifact : seal.artifacts) {
        out.write_u8(std::to_underlying(artifact.kind));
        out.write_bytes(artifact.digest);
    }
}

}

auto release_seal_signed_bytes(const release_seal& seal) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(seal));
    detail::writer out;
    write_signed(out, seal);
    return out.take();
}

auto sign_release_seal(release_seal seal, const crypto::signing_key& code_key) -> release_seal {
    seal.signature = code_key.sign(release_seal_signed_bytes(seal));
    return seal;
}

auto encode_release_seal(const release_seal& seal) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(seal));
    detail::writer out;
    write_signed(out, seal);
    out.write_bytes(seal.signature);
    return out.take();
}

auto decode_release_seal(std::span<const std::byte> bytes) -> result<release_seal> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("release seal", version));
    release_seal seal;
    seal.product = LUCENT_TRY(input.read_product());
    seal.chosen = static_cast<channel>(LUCENT_TRY(input.read_u8()));
    seal.number = LUCENT_TRY(input.read_u64());
    seal.release.bytes = LUCENT_TRY(input.read_array<id_size>());
    seal.boot_info_version = LUCENT_TRY(input.read_u32());
    const u8 count = LUCENT_TRY(input.read_u8());
    if (usize{count} * artifact_size > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    for (u8 index = 0; index < count; ++index) {
        release_artifact artifact;
        artifact.kind = static_cast<artifact_kind>(LUCENT_TRY(input.read_u8()));
        artifact.digest = LUCENT_TRY(input.read_array<crypto::digest_size>());
        seal.artifacts.push_back(artifact);
    }
    seal.signature = LUCENT_TRY(input.read_array<crypto::signature_size>());
    if (!is_canonical(seal)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(seal));
}

auto verify_release_seal(std::span<const std::byte> bytes, const crypto::public_key& code_key)
    -> result<release_seal> {
    release_seal seal = LUCENT_TRY(decode_release_seal(bytes));
    LUCENT_TRY(crypto::verify(code_key, release_seal_signed_bytes(seal), seal.signature));
    return seal;
}

}
