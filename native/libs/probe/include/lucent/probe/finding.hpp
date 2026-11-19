#pragma once

#include <expected>
#include <span>

namespace lucent::probe {

// Why a search settled on no value.
enum class miss : u8 {
    none,
    // More than one distinct value: the search can't tell which is meant.
    ambiguous,
};

// The one value a search settled on: an RVA, an index, an offset or a number.
using finding = std::expected<u64, miss>;

// The one distinct value among the candidates, however often it occurs.
auto one(std::span<const u64> candidates) -> finding;
auto one(std::span<const u32> candidates) -> finding;

}
