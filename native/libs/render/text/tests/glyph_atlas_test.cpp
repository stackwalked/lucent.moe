#include <lucent/text/glyph_atlas.hpp>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <ranges>
#include <span>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/frame_data.hpp>

#include "lucent/draw/atlas_patch.hpp"

namespace lucent::text {
namespace {

constexpr atlas_limits small{.page_size = 64, .page_count = 3};

auto padded(const atlas_slot& slot) -> draw::pixel_rect {
    return {
        .left = slot.area.left - glyph_atlas::padding,
        .top = slot.area.top - glyph_atlas::padding,
        .right = slot.area.right + glyph_atlas::padding,
        .bottom = slot.area.bottom + glyph_atlas::padding,
    };
}

auto is_overlapping(const draw::pixel_rect& left, const draw::pixel_rect& right) -> bool {
    return left.left < right.right
           && right.left < left.right
           && left.top < right.bottom
           && right.top < left.bottom;
}

auto is_inside(const draw::pixel_rect& area, i32 page_size) -> bool {
    return area.left >= 0 && area.top >= 0 && area.right <= page_size && area.bottom <= page_size;
}

// Pairs of entries on one page whose padded areas meet.
auto overlaps(std::span<const atlas_slot> slots) -> isize {
    isize found = 0;
    for (const auto [index, slot] : std::views::enumerate(slots)) {
        found += std::ranges::count_if(
            slots.subspan(narrow<usize>(index) + 1), [&slot](const atlas_slot& other) {
                return other.page == slot.page && is_overlapping(padded(slot), padded(other));
            }
        );
    }
    return found;
}

// Every test here sizes its allocations to succeed.
auto allocated(glyph_atlas& atlas, draw::pixel_size size, atlas_lifetime lifetime) -> atlas_slot {
    const std::optional<atlas_slot> slot = atlas.allocate(size, lifetime);
    LUCENT_INVARIANT(slot.has_value());
    return *slot;
}

// A page of the small atlas holds exactly four of these: two shelves of two.
constexpr draw::pixel_size quarter{.width = 30, .height = 30};

auto fill_page(glyph_atlas& atlas, atlas_lifetime lifetime) -> std::vector<atlas_slot> {
    std::vector<atlas_slot> slots;
    std::ranges::for_each(std::views::iota(0, 4), [&](i32 /*entry*/) {
        slots.push_back(allocated(atlas, quarter, lifetime));
    });
    return slots;
}

TEST_CASE("entries never overlap one another or leave their page, padding included") {
    glyph_atlas atlas{{.page_size = 256, .page_count = 4}};
    std::vector<atlas_slot> slots;
    // Sizes from 1 to 40 on each side, in an order that mixes heights across shelves.
    for (const i32 entry : std::views::iota(0, 200)) {
        const draw::pixel_size size{
            .width = 1 + ((entry * 7) % 40),
            .height = 1 + ((entry * 13) % 40),
        };
        slots.push_back(allocated(atlas, size, atlas_lifetime::evictable));
    }

    CHECK(overlaps(slots) == 0);
    CHECK(std::ranges::all_of(slots, [](const atlas_slot& slot) {
        return is_inside(padded(slot), 256);
    }));
    CHECK(atlas.evictions() == 0);
}

TEST_CASE("a full atlas clears its least recently used page, never one touched this frame") {
    glyph_atlas atlas{small};
    const std::vector<atlas_slot> first = fill_page(atlas, atlas_lifetime::evictable);
    atlas.begin_frame();
    const std::vector<atlas_slot> second = fill_page(atlas, atlas_lifetime::evictable);
    atlas.begin_frame();
    const std::vector<atlas_slot> third = fill_page(atlas, atlas_lifetime::evictable);
    atlas.begin_frame();
    // The oldest page is drawn from this frame, so the next oldest goes.
    atlas.touch(first.front().page);

    const atlas_slot fresh = allocated(atlas, quarter, atlas_lifetime::evictable);

    CHECK(fresh.page == second.front().page);
    CHECK(atlas.evictions() == 1);
    CHECK_FALSE(atlas.is_current(second.front()));
    CHECK(atlas.is_current(first.front()));
    CHECK(atlas.is_current(third.front()));
    CHECK(atlas.is_current(fresh));
}

TEST_CASE("when every page was touched this frame an entry waits for the next frame") {
    glyph_atlas atlas{small};
    std::ignore = fill_page(atlas, atlas_lifetime::evictable);
    std::ignore = fill_page(atlas, atlas_lifetime::evictable);
    std::ignore = fill_page(atlas, atlas_lifetime::evictable);

    CHECK(atlas.allocate(quarter, atlas_lifetime::evictable) == std::nullopt);

    atlas.begin_frame();
    CHECK(atlas.allocate(quarter, atlas_lifetime::evictable).has_value());
}

TEST_CASE("pinned pages are never cleared and never take glyphs") {
    glyph_atlas atlas{small};
    const atlas_slot icon = allocated(atlas, quarter, atlas_lifetime::pinned);
    std::vector<atlas_slot> glyphs;
    std::ranges::for_each(std::views::iota(0, 6), [&](i32 /*frame*/) {
        glyphs.append_range(fill_page(atlas, atlas_lifetime::evictable));
        atlas.begin_frame();
    });

    CHECK(std::ranges::none_of(glyphs, [&icon](const atlas_slot& glyph) {
        return glyph.page == icon.page;
    }));
    CHECK(atlas.is_current(icon));
    CHECK(atlas.evictions() > 0);
}

TEST_CASE("a pinned entry is refused once the pinned pages are full, rather than evicting") {
    glyph_atlas atlas{small};
    std::ignore = fill_page(atlas, atlas_lifetime::pinned);
    std::ignore = fill_page(atlas, atlas_lifetime::pinned);
    std::ignore = fill_page(atlas, atlas_lifetime::pinned);
    atlas.begin_frame();

    CHECK(atlas.allocate(quarter, atlas_lifetime::pinned) == std::nullopt);
    CHECK(atlas.evictions() == 0);
}

TEST_CASE("an entry larger than a page is refused") {
    glyph_atlas atlas{small};

    CHECK(atlas.allocate({.width = 63, .height = 4}, atlas_lifetime::evictable) == std::nullopt);
    CHECK(atlas.allocate({.width = 62, .height = 62}, atlas_lifetime::evictable).has_value());
}

// The patch's texels, row by row.
auto texels_of(const draw::atlas_patch& patch) -> std::vector<std::byte> {
    std::vector<std::byte> texels;
    const isize width = patch.area.right - patch.area.left;
    for (const isize row : std::views::iota(isize{0}, isize{patch.area.bottom - patch.area.top})) {
        texels.append_range(
            patch.coverage.subspan(narrow<usize>(row * patch.row_pitch), narrow<usize>(width))
        );
    }
    return texels;
}

TEST_CASE("a patch carries what was written, once, and a reused page's borders come back clear") {
    glyph_atlas atlas{{.page_size = 64, .page_count = 1}};
    const atlas_slot whole =
        allocated(atlas, {.width = 62, .height = 62}, atlas_lifetime::evictable);
    const std::vector<std::byte> solid(narrow<usize>(isize{62} * 62), std::byte{0xff});
    atlas.write(whole, solid, 62);
    std::ignore = atlas.take_patches();
    atlas.begin_frame();

    const atlas_slot reused =
        allocated(atlas, {.width = 2, .height = 2}, atlas_lifetime::evictable);
    const std::vector<std::byte> ink{std::byte{1}, std::byte{2}, std::byte{3}, std::byte{4}};
    atlas.write(reused, ink, 2);
    const std::vector<draw::atlas_patch> patches = atlas.take_patches();

    REQUIRE(patches.size() == 1);
    CHECK(patches.front().page == reused.page);
    CHECK(patches.front().area == padded(reused));
    const std::byte clear{0};
    CHECK(
        texels_of(patches.front())
        == std::vector<std::byte>{
            clear,
            clear,
            clear,
            clear,
            clear,
            std::byte{1},
            std::byte{2},
            clear,
            clear,
            std::byte{3},
            std::byte{4},
            clear,
            clear,
            clear,
            clear,
            clear,
        }
    );
    CHECK(atlas.take_patches().empty());
    CHECK(atlas.every_page().size() == 1);
}

}
}
