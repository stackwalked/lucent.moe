#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <optional>
#include <string_view>
#include <vector>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>
#include <lucent/wire/start.hpp>

// What the vectors and the tests build their messages from. Keys are published test keys: RFC
// 8032's first (the lease key) and RFC 7748's two parties (module and server); ids and nonces are
// a repeated byte that says which field they are.

namespace lucent::wire::fixtures {

template <usize Size>
constexpr auto filled(u8 value) -> std::array<std::byte, Size> {
    std::array<std::byte, Size> out{};
    out.fill(static_cast<std::byte>(value));
    return out;
}

constexpr auto nibble(char digit) -> u8 {
    if (digit >= '0' && digit <= '9') {
        return static_cast<u8>(digit - '0');
    }
    return static_cast<u8>(digit - 'a' + 10);
}

template <usize Size>
consteval auto bytes_of(std::string_view hex) -> std::array<std::byte, Size> {
    std::array<std::byte, Size> out{};
    for (usize index = 0; index < Size; ++index) {
        const u8 high = nibble(hex.at(2 * index));
        const u8 low = nibble(hex.at((2 * index) + 1));
        out.at(index) = static_cast<std::byte>((u32{high} << 4U) | u32{low});
    }
    return out;
}

constexpr crypto::seed lease_seed =
    bytes_of<32>("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
// RFC 8032's second key: one that signed nothing here.
constexpr crypto::seed other_seed =
    bytes_of<32>("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");
constexpr crypto::seed module_seed =
    bytes_of<32>("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
constexpr crypto::seed server_seed =
    bytes_of<32>("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");

constexpr session_id session{.bytes = filled<id_size>(0x11)};
constexpr device_id device{.bytes = filled<id_size>(0x22)};
constexpr release_id release{.bytes = filled<id_size>(0x33)};
constexpr release_id loader_release{.bytes = filled<id_size>(0x44)};
constexpr start_id start{.bytes = filled<id_size>(0x55)};
constexpr enrollment_id enrollment{.bytes = filled<id_size>(0x66)};
constexpr module_nonce hello_nonce = filled<module_nonce_size>(0x77);
constexpr module_nonce renewal_nonce = filled<module_nonce_size>(0x78);
constexpr crypto::aead_nonce first_lease_nonce = filled<crypto::aead_nonce_size>(0x88);
constexpr crypto::aead_nonce first_data_nonce = filled<crypto::aead_nonce_size>(0x8b);
constexpr crypto::aead_nonce renewal_frame_nonce = filled<crypto::aead_nonce_size>(0x89);
constexpr crypto::aead_nonce lease_frame_nonce = filled<crypto::aead_nonce_size>(0x8a);

inline auto hello() -> session_hello {
    return session_hello{
        .module_key = crypto::exchange_key::from_seed(module_seed).public_part(),
        .nonce = hello_nonce,
        .release = release,
        .boot = boot_report{
            .boot_info_version = 3,
            .kind = image_kind::mapped,
            .image_base = 0x0000'7ff6'1234'0000,
            .image_size = 0x0004'c000,
        },
    };
}

inline auto exchange() -> session_exchange {
    return sign_session_exchange(
        session_exchange{
            .session = session,
            .module_key = crypto::exchange_key::from_seed(module_seed).public_part(),
            .nonce = hello_nonce,
            .server_key = crypto::exchange_key::from_seed(server_seed).public_part(),
            .signature = {},
        },
        crypto::signing_key::from_seed(lease_seed)
    );
}

inline auto unsigned_lease(entitled_features entitled) -> lease {
    return lease{
        .session = session,
        .device = device,
        .release = release,
        .sequence = 1,
        .nonce = hello_nonce,
        .duration = std::chrono::milliseconds{60'000},
        .data_revision = 7,
        .challenge =
            hash_challenge{
                .nonce = filled<challenge_nonce_size>(0x99),
                .offset = 0x1000,
                .size = 0x200,
            },
        .product = "cs2",
        .entitled = std::move(entitled),
        .signature = {},
    };
}

inline auto first_lease() -> lease {
    return sign_lease(
        unsigned_lease(
            entitled_features{
                .is_everything = false,
                .features = {0x0123'4567'89ab'cdef, 0x8000'0000'0000'0001},
            }
        ),
        crypto::signing_key::from_seed(lease_seed)
    );
}

inline auto everything_lease() -> lease {
    return sign_lease(
        unsigned_lease(entitled_features{.is_everything = true, .features = {}}),
        crypto::signing_key::from_seed(lease_seed)
    );
}

inline auto keys() -> session_keys {
    const crypto::exchange_key module = crypto::exchange_key::from_seed(module_seed);
    const crypto::exchange_key server = crypto::exchange_key::from_seed(server_seed);
    const result<crypto::secret_key> shared = module.shared_secret(server.public_part());
    LUCENT_INVARIANT(shared.has_value());
    return derive_session_keys(
        *shared,
        exchange_halves{.module_key = module.public_part(), .server_key = server.public_part()}
    );
}

inline auto module_builds() -> std::vector<bundle::module_key> {
    return {
        bundle::module_key{
            .name_hash = 0x1111'2222'3333'4444,
            .time_date_stamp = 0x6731'a2f0,
            .size_of_image = 0x04c2'e000,
        },
        bundle::module_key{
            .name_hash = 0x5555'6666'7777'8888,
            .time_date_stamp = 0x6731'a2f1,
            .size_of_image = 0x0012'3000,
        },
    };
}

// A real, signed fact set for the first module build, every entry delivered.
inline auto first_bundle() -> std::vector<std::byte> {
    const bundle::fact_set full = bundle::sign_fact_set(
        bundle::fact_set_header{
            .game = 1,
            .revision = 3,
            .modules = {module_builds().front()},
        },
        {bundle::literal(0x10, 0x1000), bundle::literal(0x20, 0x2000)},
        crypto::signing_key::from_seed(lease_seed)
    );
    const std::array sets{bundle::deliver_all(full)};
    return bundle::encode_bundle(sets);
}

inline auto data_request_of() -> data_request {
    return data_request{
        .modules = module_builds(),
        .features = std::vector<u64>{0x0123'4567'89ab'cdef, 0x8000'0000'0000'0001},
    };
}

inline auto data_request_everything() -> data_request {
    return data_request{.modules = module_builds(), .features = std::nullopt};
}

// The first data: the first module build's set, the second not yet supported.
inline auto first_data() -> data_response {
    return data_response{
        .data_revision = 7,
        .bundle_bytes = first_bundle(),
        .unsupported = {module_builds().back()},
    };
}

inline auto reply() -> session_reply {
    const std::vector<std::byte> plain = encode_lease(first_lease());
    const std::vector<std::byte> encoded_data = encode_data_response(first_data());
    return session_reply{
        .exchange = exchange(),
        .first_lease = seal_frame(
            keys().lease.server_to_module,
            frame_contents{
                .header =
                    frame_header{
                        .session = session,
                        .way = direction::server_to_module,
                        .sequence = 0,
                    },
                .nonce = first_lease_nonce,
                .plain = plain,
            }
        ),
        .first_data = seal_frame(
            keys().data.server_to_module,
            frame_contents{
                .header =
                    frame_header{
                        .session = session,
                        .way = direction::server_to_module,
                        .sequence = 0,
                    },
                .nonce = first_data_nonce,
                .plain = encoded_data,
            }
        ),
    };
}

inline auto renewal() -> lease_renewal {
    lease_renewal out{
        .sequence = 2,
        .nonce = renewal_nonce,
        .challenge_answer = filled<crypto::digest_size>(0xaa),
        .signals = {},
    };
    out.signals.front() = std::byte{0x01};
    out.signals.back() = std::byte{0x80};
    return out;
}

inline auto renewal_frame() -> frame {
    const std::vector<std::byte> plain = encode_lease_renewal(renewal());
    return seal_frame(
        keys().lease.module_to_server,
        frame_contents{
            .header =
                frame_header{
                    .session = session,
                    .way = direction::module_to_server,
                    .sequence = 0,
                },
            .nonce = renewal_frame_nonce,
            .plain = plain,
        }
    );
}

// The loader's answer to the first lease response's challenge, and the renewal behind it.
inline auto lease_request_of() -> lease_request {
    return lease_request{
        .loader_answer = filled<crypto::digest_size>(0xbb),
        .renewal = renewal_frame(),
    };
}

// The lease the renewal is answered with: the next sequence, the renewal's nonce.
inline auto second_lease() -> lease {
    lease next = unsigned_lease(entitled_features{.is_everything = true, .features = {}});
    next.sequence = 2;
    next.nonce = renewal_nonce;
    return sign_lease(std::move(next), crypto::signing_key::from_seed(lease_seed));
}

inline auto lease_response_of() -> lease_response {
    const std::vector<std::byte> plain = encode_lease(second_lease());
    return lease_response{
        .loader_challenge =
            hash_challenge{
                .nonce = filled<challenge_nonce_size>(0x9a),
                .offset = 0x2000,
                .size = 0x100,
            },
        .lease = seal_frame(
            keys().lease.server_to_module,
            frame_contents{
                .header =
                    frame_header{
                        .session = session,
                        .way = direction::server_to_module,
                        .sequence = 1,
                    },
                .nonce = lease_frame_nonce,
                .plain = plain,
            }
        ),
    };
}

inline auto request() -> start_request {
    return start_request{
        .product = "cs2",
        .chosen = channel::alpha,
        .loader_release = loader_release,
        .modules = module_builds(),
    };
}

inline auto start_reply_of() -> start_reply {
    return start_reply{
        .start = start,
        .container_key = crypto::secret_key::from_bytes(filled<container_key_size>(0xcc)),
        .release_seal = {std::byte{0xde}, std::byte{0xad}, std::byte{0xbe}, std::byte{0xef}},
    };
}

}
