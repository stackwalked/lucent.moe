#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/draw/atlas_patch.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>

namespace lucent::text {

// A page holds one kind of entry. Pinned pages (icons) are never cleared; evictable pages (glyphs)
// are cleared whole when the atlas needs room.
enum class atlas_lifetime : u8 {
    evictable,
    pinned,
};

// Where an entry's coverage lives, in texels of its page, padding excluded. It is current while
// its page's generation is the one it was allocated in: clearing a page moves the generation on,
// so every entry on it goes stale at once without being visited.
struct atlas_slot {
    draw::atlas_page page{};
    u32 generation = 0;
    draw::pixel_rect area;

    auto operator==(const atlas_slot&) const -> bool = default;
};

struct atlas_limits {
    i32 page_size = draw::atlas_page_size;
    isize page_count = draw::atlas_page_count;
};

// Fixed A8 pages packed in shelves, with a CPU copy of every page so a new device can be given
// them again. Frames matter to eviction: a page touched this frame is never cleared, since a quad
// recorded this frame may still sample it. When nothing can be cleared an allocation is refused,
// and the caller tries again next frame.
class glyph_atlas final {
public:
    // Texels of empty border around every entry, so filtering never reads a neighbour.
    static constexpr i32 padding = 1;

    explicit glyph_atlas(atlas_limits limits);

    auto begin_frame() -> void;

    // Touches the page it lands on. Refused when the entry can't fit in an empty page, or every
    // page of its lifetime is full and none can be cleared.
    auto allocate(draw::pixel_size size, atlas_lifetime lifetime) -> std::optional<atlas_slot>;
    auto is_current(const atlas_slot& slot) const -> bool;
    auto touch(draw::atlas_page page) -> void;
    // Coverage for a current slot, its size exactly, rows row_pitch bytes apart.
    auto write(const atlas_slot& slot, std::span<const std::byte> coverage, isize row_pitch)
        -> void;

    // What changed since the last call, one patch per page. The coverage is borrowed from the
    // atlas until it next allocates or writes.
    auto take_patches() -> std::vector<draw::atlas_patch>;
    // Every page in use, whole: what a new device needs. Borrowed like take_patches().
    auto every_page() const -> std::vector<draw::atlas_patch>;

    // Pages cleared to make room, since construction.
    auto evictions() const -> i64;

private:
    struct shelf {
        i32 top = 0;
        i32 height = 0;
        i32 used = 0;
    };

    enum class page_use : u8 {
        empty,
        evictable,
        pinned,
    };

    struct page {
        page_use use = page_use::empty;
        u32 generation = 0;
        i64 last_used = -1;
        std::vector<shelf> shelves;
        i32 next_top = 0;
        std::vector<std::byte> coverage;
        std::optional<draw::pixel_rect> dirty;
    };

    auto place(isize index, draw::pixel_size padded) -> std::optional<atlas_slot>;
    auto victim() const -> std::optional<isize>;
    auto clear(isize index) -> void;
    auto patch_of(isize index, const draw::pixel_rect& area) const -> draw::atlas_patch;

    i32 m_page_size = 0;
    std::vector<page> m_pages;
    i64 m_frame = 0;
    i64 m_evictions = 0;
};

}
