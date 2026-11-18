#pragma once

#include <algorithm>
#include <optional>
#include <vector>

#include <lucent/draw/frame_data.hpp>

namespace lucent::d3d11 {

struct scratch_key {
    i32 width = 0;
    i32 height = 0;
    u32 format = 0;

    auto operator==(const scratch_key&) const -> bool = default;
};

// Sides round up to whole buckets, so a surface that changes size every frame (a pane dragged
// against the screen edge, a popup animating) reuses one texture instead of making one a frame.
inline constexpr i32 scratch_bucket = 64;
// A surface nobody has used for this many frames (four seconds at 60 Hz) is released.
inline constexpr i64 scratch_lifetime = 240;

constexpr auto bucketed(draw::pixel_size size) -> draw::pixel_size {
    const auto round_up = [](i32 side) {
        return std::max(1, (side + scratch_bucket - 1) / scratch_bucket) * scratch_bucket;
    };
    return {.width = round_up(size.width), .height = round_up(size.height)};
}

static_assert(bucketed({.width = 1, .height = 64}).width == 64);
static_assert(bucketed({.width = 1, .height = 64}).height == 64);
static_assert(bucketed({.width = 65, .height = 0}).width == 128);
static_assert(bucketed({.width = 65, .height = 0}).height == 64);

// The bookkeeping of the scratch surfaces: which exist, which are in use this frame, and when each
// was last used. The renderer keeps the textures in a vector in the same order.
class scratch_pool final {
public:
    // A free entry made with this key, now in use; absent when the caller must make one and add it.
    auto acquire(const scratch_key& key) -> std::optional<isize>;
    // A new entry, in use, at the end.
    auto add(const scratch_key& key) -> isize;
    auto release(isize entry) -> void;
    auto key_of(isize entry) const -> const scratch_key&;

    // Starts a frame: entries unused for scratch_lifetime frames are dropped, and their indices
    // returned highest first, so the caller can erase its textures in that order. Nothing may be in
    // use.
    auto next_frame() -> std::vector<isize>;

private:
    struct entry {
        scratch_key key;
        i64 last_used = 0;
        bool is_in_use = false;
    };

    std::vector<entry> m_entries;
    i64 m_frame = 0;
};

}
