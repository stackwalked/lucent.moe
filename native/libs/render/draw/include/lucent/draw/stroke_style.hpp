#pragma once

#include <lucent/draw/segment.hpp>

namespace lucent::draw {

// A rect's or circle's stroke lies inside its edge, so a stroked and a filled shape of the same
// bounds cover the same pixels; an arc's or segment's is centred on it. ends applies to segments.
struct stroke_style {
    f32 width = 1.0F;
    cap ends = cap::butt;
};

}
