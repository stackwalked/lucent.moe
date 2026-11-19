#include <lucent/foreign/memory_source.hpp>

#include <array>
#include <bit>
#include <span>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/foreign_ptr32.hpp>
#include <lucent/os/process.hpp>

namespace lucent::foreign {
namespace {

// A 32-bit target's node: a value and the next node, as stable lays out a linked structure.
struct node32 {
    u32 value = 0;
    foreign_ptr32<node32> next;
};

constexpr u64 fixture_base = 0x1000;

// Windows never maps the first 64 KiB, so this always faults.
constexpr u64 unmapped_address = 0x10;

TEST_CASE("laid-out bytes read back at their base address") {
    std::array<u32, 2> words{0x1111'1111, 0x2222'2222};
    const memory_source source =
        memory_source::from_bytes(fixture_base, std::as_writable_bytes(std::span{words}));
    const result<u32> second = read(source, element(foreign_ptr<u32>{.address = fixture_base}, 1));
    REQUIRE(second.has_value());
    CHECK(*second == 0x2222'2222);
}

TEST_CASE("a read reaching past the laid-out bytes fails instead of reading the rest") {
    std::array<u32, 2> words{};
    const memory_source source =
        memory_source::from_bytes(fixture_base, std::as_writable_bytes(std::span{words}));
    CHECK_FALSE(read(source, foreign_ptr<u64>{.address = fixture_base + 4}).has_value());
    CHECK_FALSE(read(source, foreign_ptr<u32>{.address = fixture_base - 4}).has_value());
    CHECK_FALSE(read(source, foreign_ptr<u32>{.address = ~u64{0} - 1}).has_value());
}

TEST_CASE("a write lands in the laid-out bytes and one reaching past them changes nothing") {
    std::array<u32, 2> words{};
    const memory_source source =
        memory_source::from_bytes(fixture_base, std::as_writable_bytes(std::span{words}));
    const foreign_ptr<u32> second = element(foreign_ptr<u32>{.address = fixture_base}, 1);
    CHECK(write(source, second, u32{0x3333'3333}).has_value());
    CHECK_FALSE(write(source, foreign_ptr<u64>{.address = fixture_base + 4}, u64{1}).has_value());
    CHECK(words[0] == 0);
    CHECK(words[1] == 0x3333'3333);
}

TEST_CASE("a null foreign pointer reads as a failure") {
    std::array<u32, 1> words{};
    const memory_source source =
        memory_source::from_bytes(0, std::as_writable_bytes(std::span{words}));
    CHECK_FALSE(read(source, foreign_ptr<u32>{}).has_value());
}

TEST_CASE("a 32-bit target's structure is followed through its 32-bit pointers") {
    std::array<node32, 2> nodes{
        node32{.value = 7, .next = {.address = fixture_base + sizeof(node32)}},
        node32{.value = 9, .next = {}},
    };
    const memory_source source =
        memory_source::from_bytes(fixture_base, std::as_writable_bytes(std::span{nodes}));
    const result<node32> first = read(source, foreign_ptr32<node32>{.address = fixture_base});
    REQUIRE(first.has_value());
    const result<node32> second = read(source, first->next);
    REQUIRE(second.has_value());
    CHECK(second->value == 9);
    CHECK(is_null(second->next));
}

TEST_CASE("this process reads its own memory and turns a fault into a failure") {
    const u64 value = 0x0123'4567'89ab'cdef;
    const memory_source source = memory_source::this_process();
    const result<u64> copied =
        read(source, foreign_ptr<u64>{.address = std::bit_cast<uptr>(&value)});
    REQUIRE(copied.has_value());
    CHECK(*copied == value);
    CHECK_FALSE(read(source, foreign_ptr<u64>{.address = unmapped_address}).has_value());
}

TEST_CASE("another process is read through its handle and an unmapped address fails") {
    const u64 value = 0x0123'4567'89ab'cdef;
    const result<os::process> self = os::process::open(GetCurrentProcessId());
    REQUIRE(self.has_value());
    const memory_source source = memory_source::from_process(*self);
    const result<u64> copied =
        read(source, foreign_ptr<u64>{.address = std::bit_cast<uptr>(&value)});
    REQUIRE(copied.has_value());
    CHECK(*copied == value);
    CHECK_FALSE(read(source, foreign_ptr<u64>{.address = unmapped_address}).has_value());
}

}
}
