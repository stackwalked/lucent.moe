#pragma once

#include <algorithm>

#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

// An axis-aligned box from its top-left (min) to its bottom-right (max) corner.
struct rect {
    vec2 min;
    vec2 max;

    auto operator==(const rect&) const -> bool = default;
};

constexpr auto is_empty(const rect& box) -> bool {
    return box.max.x <= box.min.x || box.max.y <= box.min.y;
}

constexpr auto intersect(const rect& left, const rect& right) -> rect {
    return {
        .min = {.x = std::max(left.min.x, right.min.x), .y = std::max(left.min.y, right.min.y)},
        .max = {.x = std::min(left.max.x, right.max.x), .y = std::min(left.max.y, right.max.y)},
    };
}

}
