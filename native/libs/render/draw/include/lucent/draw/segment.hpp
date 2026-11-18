#pragma once

#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

struct segment {
    vec2 from;
    vec2 to;
};

enum class cap : u8 { butt, round };

}
