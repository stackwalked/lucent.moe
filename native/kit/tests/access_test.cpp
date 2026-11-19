#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <tuple>

#include <catch2/catch_test_macros.hpp>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/read_access.hpp>
#include <lucent/kit/write_access.hpp>

// A game laid out in bytes, standing in for a module: a data section holding a pointer to an array
// of players, each with a health field.

namespace lucent::kit {
namespace {

constexpr u8 game_module = 2;
constexpr u64 image_base = 0x40'0000;
constexpr isize image_size = 0x200;
constexpr isize root_rva = 0x10;
constexpr isize players_rva = 0x100;
constexpr isize player_stride = 0x20;
constexpr isize health_offset = 0x8;

struct player;

LUCENT_FACT fact::global<player*> access_root{"access_root", game_module};
LUCENT_FACT fact::value<i32> access_player_size{
    "access_player_size",
    game_module,
    {.min = 0x10, .max = 0x100},
};
LUCENT_FACT fact::field<player, i32> access_health{
    "access_health",
    game_module,
    "access_player_size",
};
LUCENT_FACT fact::field<player, i32> access_armor{
    "access_armor",
    game_module,
    "access_player_size",
};

using players = capability<access_root, access_player_size, access_health>;
using armor = capability<access_armor>;

// Reaching for a fact outside the capability fails to compile; the concept turns that into a value.
template <typename Access, const auto& Field>
concept can_read_field =
    requires(const Access& access, foreign::foreign_ptr<owner_type<Field>> owner) {
        access.template read<Field>(owner);
    };

static_assert(can_read_field<read_access<players>, access_health>);
static_assert(!can_read_field<read_access<players>, access_armor>);
static_assert(!can_read_field<read_access<armor>, access_health>);

auto put(std::span<std::byte> bytes, isize offset, std::span<const std::byte> value) -> void {
    std::ranges::copy(value, bytes.subspan(static_cast<usize>(offset)).begin());
}

// The root pointer aimed at the players, and the second player's health.
auto laid_out_game() -> std::array<std::byte, image_size> {
    std::array<std::byte, image_size> bytes{};
    const u64 players_address = image_base + players_rva;
    const i32 second_health = 75;
    put(bytes, root_rva, std::as_bytes(std::span{&players_address, 1}));
    put(bytes,
        players_rva + player_stride + health_offset,
        std::as_bytes(std::span{&second_health, 1}));
    return bytes;
}

auto game_image() -> module_image {
    return module_image{
        .index = game_module,
        .base = image_base,
        .size = image_size,
        .sections =
            {
                image_section{
                    .rva = 0,
                    .size = image_size,
                    .is_executable = false,
                    .is_writable = true,
                },
            },
        .time_date_stamp = 0,
        .size_of_image = image_size,
    };
}

// Resolves the players' facts; armor gets no value.
auto resolve_players() -> void {
    const std::array values{
        fact_value{.key = access_root.record().key, .value = root_rva},
        fact_value{.key = access_player_size.record().key, .value = player_stride},
        fact_value{.key = access_health.record().key, .value = health_offset},
    };
    const std::array modules{game_image()};
    std::ignore = resolve(linked_fact_records(), values, modules);
}

TEST_CASE(
    "a builder follows the target's own pointer to an element's field through its capability"
) {
    resolve_players();
    std::array<std::byte, image_size> game = laid_out_game();
    const read_access<players> access{foreign::memory_source::from_bytes(image_base, game)};

    const result<foreign::foreign_ptr<player>> first = access.read<access_root>();
    REQUIRE(first.has_value());
    const foreign::foreign_ptr<player> second = access.element<access_player_size>(*first, 1);
    const result<i32> health = access.read<access_health>(second);

    REQUIRE(health.has_value());
    CHECK(*health == 75);
}

TEST_CASE("a field written through write_access is what read_access then reads") {
    resolve_players();
    std::array<std::byte, image_size> game = laid_out_game();
    const foreign::memory_source source = foreign::memory_source::from_bytes(image_base, game);
    const read_access<players> reader{source};
    const write_access<players> writer{source};
    const foreign::foreign_ptr<player> first{.address = image_base + players_rva};

    REQUIRE(writer.write<access_health>(first, 40).has_value());
    const result<i32> health = reader.read<access_health>(first);

    REQUIRE(health.has_value());
    CHECK(*health == 40);
}

TEST_CASE("a field of a null owner fails to read instead of reading memory near address zero") {
    resolve_players();
    std::array<std::byte, image_size> low_memory{};
    const read_access<players> access{foreign::memory_source::from_bytes(0, low_memory)};
    CHECK_FALSE(access.read<access_health>(foreign::foreign_ptr<player>{}).has_value());
}

TEST_CASE("a capability is unavailable while any one of its facts is unresolved") {
    resolve_players();
    CHECK(is_available(players{}));
    CHECK_FALSE(is_available(armor{}));
}

}
}
