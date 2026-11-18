#include <array>
#include <cstddef>
#include <optional>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/probe/byte_pattern.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/probe/navigation.hpp>
#include <lucent/probe/rtti.hpp>
#include <lucent/probe/strings.hpp>

#include "images.hpp"

namespace lucent::probe {
namespace {

constexpr byte_pattern marker_bytes{"B8 67 45 23 01 C3"};
constexpr byte_pattern marker_with_wildcards{"B8 ?? 45 ?? 01 C3"};

static_assert(marker_bytes.size() == 6);
static_assert(marker_bytes.matches(
    std::array{
        std::byte{0xb8},
        std::byte{0x67},
        std::byte{0x45},
        std::byte{0x23},
        std::byte{0x01},
        std::byte{0xc3},
        std::byte{0x90},
    }
));
static_assert(marker_with_wildcards.matches(
    std::array{
        std::byte{0xb8},
        std::byte{0x00},
        std::byte{0x45},
        std::byte{0xff},
        std::byte{0x01},
        std::byte{0xc3},
    }
));
static_assert(!marker_bytes.matches(
    std::array{
        std::byte{0xb8},
        std::byte{0x67},
        std::byte{0x45},
        std::byte{0x23},
        std::byte{0x01},
    }
));
static_assert(!marker_with_wildcards.matches(
    std::array{
        std::byte{0xb9},
        std::byte{0x00},
        std::byte{0x45},
        std::byte{0xff},
        std::byte{0x01},
        std::byte{0xc3},
    }
));

auto export_rva(const module_file& module, std::string_view name) -> u32 {
    const result<pe::export_table> exports = pe::export_table::from_image(module.view());
    REQUIRE(exports.has_value());
    const result<pe::export_target> target = exports->find(name);
    REQUIRE(target.has_value());
    const std::optional<u32> rva = match(
        target.value_or(pe::forwarder{}),
        [](const pe::export_address& address) -> std::optional<u32> { return address.rva; },
        [](const pe::forwarder&) -> std::optional<u32> { return std::nullopt; }
    );
    REQUIRE(rva.has_value());
    return rva.value_or(0);
}

TEST_CASE("a class's RTTI leads to the vtable its objects point at, listing its overrides") {
    const module_file game = game_module();
    const loaded_game loaded;

    const std::vector<rtti_vtable> vtables = rtti_vtables_of(game, "game::client_mode");
    REQUIRE(vtables.size() == 1);
    const rtti_vtable primary = vtables.front();
    CHECK(primary.subobject_offset == 0);
    CHECK(primary.rva == loaded.vtable_of(loaded.object("fixture_client_mode")));
    CHECK(vtable_functions(game, primary.rva).size() == 2);
}

TEST_CASE("a class with two polymorphic bases has a vtable for each, at each base's offset") {
    const module_file game = game_module();
    const loaded_game loaded;
    const uptr hud = loaded.object("fixture_hud");
    const uptr as_listener = loaded.object("fixture_hud_listener");

    const std::vector<rtti_vtable> vtables = rtti_vtables_of(game, "game::hud");
    REQUIRE(vtables.size() == 2);
    CHECK(vtables.front() == rtti_vtable{.rva = loaded.vtable_of(hud), .subobject_offset = 0});
    CHECK(
        vtables.back()
        == rtti_vtable{
            .rva = loaded.vtable_of(as_listener),
            .subobject_offset = narrow<u32>(as_listener - hud),
        }
    );
}

TEST_CASE("a decorated type name finds the same vtables as the name in source") {
    const module_file game = game_module();

    CHECK(rtti_vtables_of(game, ".?AVhud@game@@") == rtti_vtables_of(game, "game::hud"));
    CHECK(rtti_vtables_of(game, "game::missing").empty());
    CHECK(rtti_vtables_of(game, "hud").empty());
}

TEST_CASE("a stored string leads to the instruction that takes its address") {
    const module_file game = game_module();
    const code_index index = code_index::build(game);

    const std::vector<u32> stored = string_rvas(game, "fixture hud");
    REQUIRE(stored.size() == 1);
    const auto users = index.references_to(stored.front());
    REQUIRE(users.size() == 1);
    const reference user = users.front();
    CHECK(user.kind == reference_kind::address);
    CHECK(reference_at(game, user.source) == user);
    CHECK(string_rvas(game, "fixture hu").empty());
}

TEST_CASE("a byte pattern finds code by its bytes, wildcards matching anything") {
    const module_file game = game_module();
    const u32 marker = export_rva(game, "fixture_marker");

    CHECK(pattern_rvas(game, marker_bytes) == std::vector{marker});
    CHECK(pattern_rvas(game, marker_with_wildcards) == std::vector{marker});
}

}
}
