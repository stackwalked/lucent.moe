#include <lucent/kit/session_message.hpp>

#include <array>
#include <cstddef>
#include <expected>
#include <initializer_list>
#include <span>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

namespace lucent::kit {
namespace {

auto round_trip(const session_message& message) -> result<session_message> {
    const std::vector<std::byte> frame = encode(message);
    const std::span<const std::byte> bytes{frame};
    const isize size = LUCENT_TRY(decode_frame_size(bytes.first<frame_header_size>()));
    REQUIRE(size == std::ssize(frame) - isize{frame_header_size});
    return decode(bytes.subspan(frame_header_size));
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
        session_message{unload_request{}}
    );
    CHECK(round_trip(message) == message);
}

// The bytes are boot_info v3's: dev text took over the log line's kind and payload unchanged.
TEST_CASE("dev text is framed as kind 1 followed by its UTF-8 bytes") {
    CHECK(encode(dev_text{.text = "hé"}) == bytes_of({4, 0, 0, 0, 1, 'h', 0xc3, 0xa9}));
}

TEST_CASE("a frame size of zero or above the bound is malformed") {
    const auto size = GENERATE(
        std::array<std::byte, 4>{},
        std::array{std::byte{0x01}, std::byte{0x00}, std::byte{0x01}, std::byte{0x00}}
    );
    CHECK(decode_frame_size(size) == std::unexpected(error{.code = error_code::malformed}));
}

TEST_CASE("a frame exactly at the bound is accepted") {
    const std::array header{std::byte{0x00}, std::byte{0x00}, std::byte{0x01}, std::byte{0x00}};
    CHECK(decode_frame_size(header) == max_frame_size);
}

TEST_CASE("a body that isn't a known message is malformed") {
    const std::vector<std::byte> body = GENERATE(
        bytes_of({}),
        bytes_of({0}),
        bytes_of({4}),
        bytes_of({255, 1, 2}),
        bytes_of({2}),
        bytes_of({2, 5}),
        bytes_of({2, 1, 1}),
        bytes_of({3, 0})
    );
    CHECK(decode(body) == std::unexpected(error{.code = error_code::malformed}));
}

}
