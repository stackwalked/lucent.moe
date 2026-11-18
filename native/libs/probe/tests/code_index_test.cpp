#include <lucent/probe/code_index.hpp>

#include <algorithm>
#include <bit>
#include <optional>
#include <span>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/module_file.hpp>

#include "own_image.hpp"

namespace lucent::probe {
namespace {

// A leaf that only takes a string's address has no unwind data, so the index sees it only by
// sweeping the gaps between listed functions.
[[gnu::noinline]] auto marker() -> const char* {
    return "lucent probe code index marker";
}

[[gnu::noinline]] auto marker_size() -> usize {
    return std::string_view{marker()}.size();
}

// The instructions a small function's references come from start within this many bytes of it.
constexpr u32 near = 64;

auto is_within(u32 source, u32 function) -> bool {
    return source >= function && source - function < near;
}

TEST_CASE("the index finds a leaf taking a string's address, and the call to that leaf") {
    const module_file module = own_module();
    const code_index index = code_index::build(module);
    const u32 string = own_rva(std::bit_cast<uptr>(marker()));
    const u32 leaf = own_rva(std::bit_cast<uptr>(&marker));
    const u32 caller = own_rva(std::bit_cast<uptr>(&marker_size));
    REQUIRE(marker_size() > 0);

    CHECK(std::ranges::any_of(index.references_to(string), [&](const reference& found) {
        return found.kind == reference_kind::address && is_within(found.source, leaf);
    }));
    CHECK(std::ranges::any_of(index.references_to(leaf), [&](const reference& found) {
        return found.kind == reference_kind::call && is_within(found.source, caller);
    }));
}

TEST_CASE("references to one target come back in source order") {
    const module_file module = own_module();
    const code_index index = code_index::build(module);
    const std::span<const reference> calls =
        index.references_to(own_rva(std::bit_cast<uptr>(&own_module)));

    CHECK_FALSE(calls.empty());
    CHECK(std::ranges::is_sorted(calls, {}, &reference::source));
    CHECK(std::ranges::all_of(calls, [&](const reference& found) {
        return found.target == own_rva(std::bit_cast<uptr>(&own_module));
    }));
}

TEST_CASE("decoding one range finds the same references the index holds for it") {
    const module_file module = own_module();
    const code_index index = code_index::build(module);
    const u32 caller = own_rva(std::bit_cast<uptr>(&marker_size));
    const std::optional<pe::runtime_function> function = module.function_containing(caller);
    REQUIRE(function.has_value());
    const pe::runtime_function range = function.value_or(pe::runtime_function{});

    for (const reference& found :
        references_in(module, {.rva = range.begin, .size = range.end - range.begin})) {
        CHECK(std::ranges::contains(index.references_to(found.target), found));
    }
}

}
}
