#pragma once

#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// What a finder rests on, which decides how far its value is trusted on its own.
enum class basis : u8 {
    // Strings, RTTI, exports, ABI registers, data flow, another fact, or consensus over many
    // sites: enough alone.
    semantic,
    // Only the shape of a function's body: trusted only beside a second, independent finder.
    shape,
    // Bytes of code: a last resort, which states why nothing better exists.
    bytes,
};

// One way to derive one fact's value from one module.
struct finder {
    // What it reads, for the generator's report: "view.cpp's matrix setup".
    std::string_view name;
    basis rests_on = basis::semantic;
    // Why only bytes will do; required for basis::bytes, empty otherwise.
    std::string_view reason;
    auto (*run)(const module_file& module, const code_index& index) -> finding = nullptr;
};

// What makes a fact's set of finders unfit to resolve it.
enum class finder_set_flaw : u8 {
    empty,
    // Its only finder matches a body's shape.
    lone_shape,
    // A byte pattern says nothing about why it's needed.
    unexplained_bytes,
};

auto flaw_of(std::span<const finder> finders) -> std::optional<finder_set_flaw>;

// What a fact's finders settled on together: the value, by the finders (as indices into the
// findings) that found it, and those that found nothing while the rest agreed.
struct agreement {
    u64 value = 0;
    std::vector<isize> agreed;
    std::vector<isize> failed;
};

enum class disagreement : u8 {
    // No finder settled on a value.
    unresolved,
    // Finders settled on different values.
    conflict,
};

// At least one finding holds a value, and every finding that holds one holds the same.
auto agree(std::span<const finding> findings) -> std::expected<agreement, disagreement>;

}
