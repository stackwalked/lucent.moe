#pragma once

#include <concepts>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string_view>
#include <utility>

#include <catch2/catch_test_macros.hpp>

namespace lucent::pe {

// The value of a result a test can't continue without.
template <std::move_constructible T>
auto required(result<T> outcome) -> T {
    REQUIRE(outcome.has_value());
    return std::move(*outcome);
}

// This test executable's own file: a real image linked by the pinned toolchain.
auto own_path() -> std::filesystem::path;

// A module loaded into this process, as bytes: its whole image as the loader mapped it.
auto loaded_image(std::wstring_view module) -> std::span<const std::byte>;

}
