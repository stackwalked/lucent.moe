#pragma once

#include <array>
#include <cstddef>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/container.hpp>
#include <lucent/wire/container_stream.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/release_seal.hpp>

#include "fixtures.hpp"

// What the container, stream and seal vectors and tests build from. The code key is RFC 8032's
// third test key; ids and keys are a repeated byte naming their field, as in fixtures.hpp.

namespace lucent::wire::fixtures {

constexpr crypto::seed code_seed =
    bytes_of<32>("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7");
constexpr release_id module_release{.bytes = filled<id_size>(0x33)};
constexpr import_key imports_key = filled<import_key_size>(0x5a);

// A page whose bytes are the low byte of their offset plus `seed`, so no page is all zero.
inline auto page_of(u8 seed) -> std::vector<std::byte> {
    std::vector<std::byte> page(container_page_size);
    for (usize index = 0; index < page.size(); ++index) {
        page.at(index) = static_cast<std::byte>(((index & 0xffU) + seed) | 1U);
    }
    return page;
}

// Code, read-only data holding .pdata and the import slots, and data with a zero-filled tail:
// every kind of section, relocation and import the format carries.
inline auto small_container() -> container {
    return container{
        .release = module_release,
        .image_size = 0x6000,
        .entry_rva = 0x1010,
        .boot_rva = 0x1020,
        .boot_info_version = 3,
        .pdata_rva = 0x3000,
        .pdata_size = 24,
        .imports_key = imports_key,
        .sections =
            {
                container_section{
                    .rva = 0x1000,
                    .mapped_size = 0x1000,
                    .access = section_access::read_execute,
                    .data = page_of(0x10),
                },
                container_section{
                    .rva = 0x2000,
                    .mapped_size = 0x2000,
                    .access = section_access::read,
                    .data = page_of(0x20),
                },
                container_section{
                    .rva = 0x4000,
                    .mapped_size = 0x2000,
                    .access = section_access::read_write,
                    .data = {},
                },
            },
        .relocations = {0x2100, 0x2108, 0x4000},
        .imports = {
            container_import{
                .module_hash = import_hash(imports_key, "kernel32.dll"),
                .function_hash = import_hash(imports_key, "GetCurrentProcessId"),
                .slot_rva = 0x2000,
            },
            container_import{
                .module_hash = import_hash(imports_key, "kernel32.dll"),
                .function_hash = import_hash(imports_key, "Sleep"),
                .slot_rva = 0x2008,
            },
        },
    };
}

// The least a container can be: one page of address space and nothing in it.
inline auto empty_container() -> container {
    return container{
        .release = module_release,
        .image_size = container_page_size,
        .entry_rva = 0,
        .boot_rva = 0,
        .boot_info_version = 3,
        .pdata_rva = 0,
        .pdata_size = 0,
        .imports_key = imports_key,
        .sections = {},
        .relocations = {},
        .imports = {},
    };
}

// The stream vector's plaintext: byte i is i mod 251, a period no chunk boundary lines up with.
inline auto stream_plain(usize size) -> std::vector<std::byte> {
    std::vector<std::byte> plain(size);
    for (usize index = 0; index < size; ++index) {
        plain.at(index) = static_cast<std::byte>(index % 251);
    }
    return plain;
}

inline constexpr usize stream_plain_size = container_chunk_size + 100;

inline auto stream_nonces(usize count) -> std::vector<crypto::aead_nonce> {
    std::vector<crypto::aead_nonce> nonces;
    nonces.reserve(count);
    for (usize index = 0; index < count; ++index) {
        nonces.push_back(filled<crypto::aead_nonce_size>(static_cast<u8>(0xa0 + index)));
    }
    return nonces;
}

inline auto container_key() -> crypto::secret_key {
    return crypto::secret_key::from_bytes(filled<container_key_size>(0xcc));
}

inline auto module_seal() -> release_seal {
    return sign_release_seal(
        release_seal{
            .product = "cs2",
            .chosen = channel::alpha,
            .number = 7,
            .release = module_release,
            .boot_info_version = 3,
            .artifacts =
                {
                    release_artifact{
                        .kind = artifact_kind::container,
                        .digest = crypto::hash(pack_container(small_container())),
                    },
                    release_artifact{
                        .kind = artifact_kind::release_manifest,
                        .digest = filled<crypto::digest_size>(0x2d),
                    },
                },
            .signature = {},
        },
        crypto::signing_key::from_seed(code_seed)
    );
}

inline auto loader_seal() -> release_seal {
    return sign_release_seal(
        release_seal{
            .product = "lucent-loader",
            .chosen = channel::stable,
            .number = 12,
            .release = loader_release,
            .boot_info_version = 3,
            .artifacts =
                {
                    release_artifact{
                        .kind = artifact_kind::loader,
                        .digest = filled<crypto::digest_size>(0x3d),
                    },
                    release_artifact{
                        .kind = artifact_kind::host,
                        .digest = filled<crypto::digest_size>(0x4d),
                    },
                },
            .signature = {},
        },
        crypto::signing_key::from_seed(code_seed)
    );
}

}
