#include "key/key_file.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>

#include "key/random.hpp"

namespace lucent::codekey {
namespace {

constexpr usize context_size = 32;
constexpr std::string_view context = "lucent offline key v1";
constexpr usize salt_size = 16;
constexpr usize sealed_seed_size = crypto::seed_size + crypto::aead_tag_size;
constexpr usize associated_size = context_size + 1 + 12 + salt_size + crypto::public_key_size;
constexpr usize file_size = associated_size + crypto::aead_nonce_size + sealed_seed_size;

constexpr error malformed{.code = error_code::malformed};

struct header {
    key_purpose purpose = key_purpose::code;
    crypto::argon2id_cost cost;
    std::array<std::byte, salt_size> salt{};
    crypto::public_key public_key{};
};

auto little_endian(u32 value) -> std::array<std::byte, 4> {
    std::array<std::byte, 4> out{};
    for (u32 index = 0; index < 4; ++index) {
        out.at(index) = static_cast<std::byte>((value >> (8U * index)) & 0xffU);
    }
    return out;
}

auto take_u32(std::span<const std::byte> bytes, usize offset) -> u32 {
    std::array<std::byte, sizeof(u32)> raw{};
    std::ranges::copy(bytes.subspan(offset, sizeof(u32)), raw.begin());
    return std::bit_cast<u32>(raw);
}

auto associated_bytes(const header& fields) -> std::vector<std::byte> {
    std::vector<std::byte> out(context_size);
    std::ranges::copy(std::as_bytes(std::span{context}), out.begin());
    out.push_back(static_cast<std::byte>(std::to_underlying(fields.purpose)));
    for (const u32 value : {fields.cost.blocks, fields.cost.passes, fields.cost.lanes}) {
        const std::array<std::byte, 4> encoded = little_endian(value);
        out.insert(out.end(), encoded.begin(), encoded.end());
    }
    out.insert(out.end(), fields.salt.begin(), fields.salt.end());
    out.insert(out.end(), fields.public_key.begin(), fields.public_key.end());
    return out;
}

auto read_header(std::span<const std::byte> file) -> result<header> {
    if (file.size() != file_size) {
        return std::unexpected(malformed);
    }
    std::array<std::byte, context_size> expected{};
    std::ranges::copy(std::as_bytes(std::span{context}), expected.begin());
    if (!std::ranges::equal(file.first(context_size), expected)) {
        return std::unexpected(malformed);
    }
    header fields;
    fields.purpose = static_cast<key_purpose>(file.subspan(context_size).front());
    fields.cost = crypto::argon2id_cost{
        .blocks = take_u32(file, context_size + 1),
        .passes = take_u32(file, context_size + 5),
        .lanes = take_u32(file, context_size + 9),
    };
    std::ranges::copy(file.subspan(context_size + 13, salt_size), fields.salt.begin());
    std::ranges::copy(
        file.subspan(context_size + 13 + salt_size, crypto::public_key_size),
        fields.public_key.begin()
    );
    return fields;
}

auto is_within_bounds(crypto::argon2id_cost cost) -> bool {
    return cost.blocks >= minimum_cost.blocks
           && cost.blocks <= crypto::max_argon2id_blocks
           && cost.passes >= minimum_cost.passes
           && cost.passes <= 64
           && cost.lanes >= 1
           && cost.lanes <= 16
           && cost.blocks >= 8 * cost.lanes;
}

auto wrapping_key(std::span<const std::byte> passphrase, const header& fields)
    -> result<crypto::secret_key> {
    return crypto::argon2id(
        crypto::argon2id_inputs{
            .passphrase = passphrase,
            .salt = fields.salt,
            .secret = {},
            .associated = {},
        },
        fields.cost
    );
}

}

auto create_key_file(std::span<const std::byte> passphrase, key_purpose purpose)
    -> result<new_key_file> {
    crypto::seed seed{};
    LUCENT_TRY(fill_random(seed));
    const crypto::signing_key signer = crypto::signing_key::from_seed(seed);
    header fields{.purpose = purpose, .cost = default_cost, .salt = {}, .public_key = {}};
    LUCENT_TRY(fill_random(fields.salt));
    fields.public_key = signer.public_part();
    crypto::aead_nonce nonce{};
    LUCENT_TRY(fill_random(nonce));
    const crypto::secret_key wrapping = LUCENT_TRY(wrapping_key(passphrase, fields));
    std::vector<std::byte> bytes = associated_bytes(fields);
    const std::vector<std::byte> sealed = crypto::seal(wrapping, nonce, bytes, seed);
    crypto::wipe(seed);
    bytes.insert(bytes.end(), nonce.begin(), nonce.end());
    bytes.insert(bytes.end(), sealed.begin(), sealed.end());
    return new_key_file{.bytes = std::move(bytes), .public_key = fields.public_key};
}

auto public_key_of(std::span<const std::byte> file) -> result<crypto::public_key> {
    return read_header(file).transform([](const header& fields) { return fields.public_key; });
}

auto open_key_file(const key_file_opening& opening) -> result<crypto::signing_key> {
    const std::span<const std::byte> file = opening.file;
    const header fields = LUCENT_TRY(read_header(file));
    if (fields.purpose != opening.purpose || !is_within_bounds(fields.cost)) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    crypto::aead_nonce nonce{};
    std::ranges::copy(file.subspan(associated_size, crypto::aead_nonce_size), nonce.begin());
    const crypto::secret_key wrapping = LUCENT_TRY(wrapping_key(opening.passphrase, fields));
    const crypto::secret_bytes seed = LUCENT_TRY(
        crypto::open(
            wrapping,
            nonce,
            file.first(associated_size),
            file.subspan(associated_size + crypto::aead_nonce_size)
        )
    );
    crypto::seed material{};
    std::ranges::copy(seed.as_bytes(), material.begin());
    crypto::signing_key signer = crypto::signing_key::from_seed(material);
    crypto::wipe(material);
    // The public key in the header is authenticated, but only a seed that gives it is the key.
    if (signer.public_part() != fields.public_key) {
        return std::unexpected(malformed);
    }
    return signer;
}

}
