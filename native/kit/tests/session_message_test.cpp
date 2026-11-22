#include <lucent/kit/session_message.hpp>

#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <initializer_list>
#include <span>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/wire/refusal.hpp>

namespace lucent::kit {
namespace {

auto round_trip(const session_message& message) -> result<session_message> {
    const std::vector<std::byte> frame = encode(message);
    const std::span<const std::byte> bytes{frame};
    const isize size = LUCENT_TRY(decode_frame_size(bytes.first<frame_header_size>()));
    REQUIRE(size == std::ssize(frame) - isize{frame_header_size});
    return decode(bytes.subspan(frame_header_size));
}

auto header_of(isize size) -> std::array<std::byte, frame_header_size> {
    return std::bit_cast<std::array<std::byte, frame_header_size>>(narrow<u32>(size));
}

auto bytes_of(std::initializer_list<u8> values) -> std::vector<std::byte> {
    std::vector<std::byte> bytes;
    for (const u8 value : values) {
        bytes.push_back(std::byte{value});
    }
    return bytes;
}

}

TEST_CASE("every message survives encoding and decoding") {
    const session_message message = GENERATE(
        session_message{dev_text{.text = "attached to cs2.exe"}},
        session_message{dev_text{.text = ""}},
        session_message{stage_reached{.reached = stage::boot}},
        session_message{stage_reached{.reached = stage::unload}},
        session_message{unload_request{}},
        session_message{start_refused{.code = wire::refusal_code::game_build_unsupported}},
        session_message{server_request{.route = server_route::session, .body = bytes_of({1, 2})}},
        session_message{server_reply{.route = server_route::lease, .body = bytes_of({9})}},
        session_message{server_request{.route = server_route::data, .body = bytes_of({3})}},
        session_message{server_reply{.route = server_route::data, .body = bytes_of({4, 5})}}
    );
    CHECK(round_trip(message) == message);
}

// The bytes are boot_info v3's: dev text took over the log line's kind and payload unchanged.
TEST_CASE("dev text is framed as kind 1 followed by its UTF-8 bytes") {
    CHECK(encode(dev_text{.text = "hé"}) == bytes_of({4, 0, 0, 0, 1, 'h', 0xc3, 0xa9}));
}

TEST_CASE("a refused start is framed as kind 4 followed by its refusal code") {
    CHECK(
        encode(start_refused{.code = wire::refusal_code::game_build_unsupported})
        == bytes_of({2, 0, 0, 0, 4, 19})
    );
}

TEST_CASE("a refused start with a code this build doesn't know still decodes, keeping its number") {
    // NOLINTNEXTLINE(clang-analyzer-optin.core.EnumCastOutOfRange): a code past the catalog is what this test sends.
    const auto unknown = static_cast<wire::refusal_code>(200);
    CHECK(decode(bytes_of({4, 200})) == session_message{start_refused{.code = unknown}});
}

TEST_CASE("a relayed body is framed as its kind, its route, then the body unchanged") {
    CHECK(
        encode(server_request{.route = server_route::lease, .body = bytes_of({0xaa, 0xbb})})
        == bytes_of({4, 0, 0, 0, 5, 2, 0xaa, 0xbb})
    );
    CHECK(
        encode(server_reply{.route = server_route::session, .body = bytes_of({0xcc})})
        == bytes_of({3, 0, 0, 0, 6, 1, 0xcc})
    );
    CHECK(
        encode(server_request{.route = server_route::data, .body = bytes_of({0xdd})})
        == bytes_of({3, 0, 0, 0, 5, 3, 0xdd})
    );
}

TEST_CASE("a frame size of zero or above the bound is malformed") {
    const auto size = GENERATE(header_of(0), header_of(max_frame_size + 1));
    CHECK(decode_frame_size(size) == std::unexpected(error{.code = error_code::malformed}));
}

TEST_CASE("a frame exactly at the bound is accepted") {
    CHECK(decode_frame_size(header_of(max_frame_size)) == max_frame_size);
}

TEST_CASE("a body that isn't a known message is malformed") {
    const std::vector<std::byte> body = GENERATE(
        bytes_of({}),
        bytes_of({0}),
        bytes_of({7}),
        bytes_of({255, 1, 2}),
        bytes_of({2}),
        bytes_of({2, 5}),
        bytes_of({2, 1, 1}),
        bytes_of({3, 0}),
        bytes_of({4}),
        bytes_of({4, 0}),
        bytes_of({4, 19, 0}),
        bytes_of({5}),
        bytes_of({5, 1}),
        bytes_of({5, 0, 1}),
        bytes_of({6, 4, 1})
    );
    CHECK(decode(body) == std::unexpected(error{.code = error_code::malformed}));
}

}
