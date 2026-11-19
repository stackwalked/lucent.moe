#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>

// The offline key's file on the owner's computer: the Ed25519 seed sealed with XChaCha20-Poly1305
// under a key Argon2id derives from a passphrase. Never on the server or in git; decrypted only for
// the moment a signature needs it.
//
// Version 1: context "lucent offline key v1" (32), u8 purpose, u32 Argon2id blocks (KiB),
// u32 passes, u32 lanes, salt (16), public key (32), nonce (24), sealed seed (32 + tag 16).
// Everything before the nonce is the associated data, so the cost, salt and public key can't be
// changed without the file failing to open.

namespace lucent::codekey {

// What the key signs. Only the code key exists yet; the facts key will share this file format.
enum class key_purpose : u8 {
    code = 1,
};

// 1 GiB, 3 passes, 1 lane. The file's threat is theft followed by offline guessing, with no rate
// limit, so each guess should cost what the owner can bear once per release: 2.6 s on one core
// of the dev machine (release build). Memory is the cost GPUs and ASICs don't cut, so it is set
// high (RFC 9106's first recommendation is 2 GiB at 1 pass; 3 passes over half that is more work
// at less peak memory). One lane, since Monocypher runs lanes one after another anyway. A file
// below the floor is refused.
inline constexpr crypto::argon2id_cost default_cost{
    .blocks = u32{1} << 20U,
    .passes = 3,
    .lanes = 1,
};
inline constexpr crypto::argon2id_cost minimum_cost{
    .blocks = u32{1} << 18U,
    .passes = 3,
    .lanes = 1,
};

// A passphrase of fewer bytes is refused: the cost above slows guessing, it can't make a short
// passphrase strong.
inline constexpr usize minimum_passphrase_size = 16;

struct new_key_file {
    std::vector<std::byte> bytes;
    crypto::public_key public_key{};
};

// A fresh seed sealed under the passphrase. Fails as system when the system RNG fails.
auto create_key_file(std::span<const std::byte> passphrase, key_purpose purpose)
    -> result<new_key_file>;

// The public key the file names, without the passphrase. Unauthenticated until opened.
auto public_key_of(std::span<const std::byte> file) -> result<crypto::public_key>;

struct key_file_opening {
    std::span<const std::byte> file;
    std::span<const std::byte> passphrase;
    key_purpose purpose = key_purpose::code;
};

// Fails as malformed when the passphrase is wrong or the file was changed, as unsupported when it
// is for another purpose or below the cost floor.
auto open_key_file(const key_file_opening& opening) -> result<crypto::signing_key>;

}
