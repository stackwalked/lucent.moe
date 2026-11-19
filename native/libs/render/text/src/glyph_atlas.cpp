#include <lucent/text/glyph_atlas.hpp>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>

#include "lucent/draw/atlas_patch.hpp"

namespace lucent::text {
namespace {

// Shelves come in steps of this many texels, so glyphs of one size and its neighbours share them.
constexpr i32 shelf_step = 4;

auto shelf_height(i32 height) -> i32 {
    return ((height + shelf_step - 1) / shelf_step) * shelf_step;
}

// A shelf taller than this wastes more than a quarter of its row on the entry.
auto is_snug(i32 shelf, i32 height) -> bool {
    return shelf >= height && shelf <= height + (height / 4) + shelf_step;
}

auto united(const std::optional<draw::pixel_rect>& dirty, const draw::pixel_rect& area)
    -> draw::pixel_rect {
    if (!dirty) {
        return area;
    }
    return {
        .left = std::min(dirty->left, area.left),
        .top = std::min(dirty->top, area.top),
        .right = std::max(dirty->right, area.right),
        .bottom = std::max(dirty->bottom, area.bottom),
    };
}

}

glyph_atlas::glyph_atlas(atlas_limits limits)
    : m_page_size{limits.page_size} {
    LUCENT_INVARIANT(limits.page_size > 0 && limits.page_count > 0);
    LUCENT_INVARIANT(limits.page_count <= draw::atlas_page_count);
    m_pages.resize(narrow<usize>(limits.page_count));
}

auto glyph_atlas::begin_frame() -> void {
    ++m_frame;
}

auto glyph_atlas::allocate(draw::pixel_size size, atlas_lifetime lifetime)
    -> std::optional<atlas_slot> {
    LUCENT_INVARIANT(size.width > 0 && size.height > 0);
    const draw::pixel_size padded{
        .width = size.width + (2 * padding),
        .height = size.height + (2 * padding),
    };
    if (padded.width > m_page_size || padded.height > m_page_size) {
        return std::nullopt;
    }
    const page_use use =
        lifetime == atlas_lifetime::pinned ? page_use::pinned : page_use::evictable;
    for (const auto [index, candidate] : std::views::enumerate(m_pages)) {
        if (candidate.use != use) {
            continue;
        }
        if (const std::optional<atlas_slot> placed = place(index, padded)) {
            return placed;
        }
    }
    const auto empty = std::ranges::find(m_pages, page_use::empty, &page::use);
    if (empty != m_pages.end()) {
        const isize index = empty - m_pages.begin();
        empty->use = use;
        empty->coverage.resize(narrow<usize>(isize{m_page_size} * m_page_size));
        return place(index, padded);
    }
    if (lifetime == atlas_lifetime::pinned) {
        return std::nullopt;
    }
    const std::optional<isize> cleared = victim();
    if (!cleared) {
        return std::nullopt;
    }
    clear(*cleared);
    return place(*cleared, padded);
}

auto glyph_atlas::is_current(const atlas_slot& slot) const -> bool {
    const auto index = isize{std::to_underlying(slot.page)};
    return index < std::ssize(m_pages)
           && m_pages.at(narrow<usize>(index)).use != page_use::empty
           && m_pages.at(narrow<usize>(index)).generation == slot.generation;
}

auto glyph_atlas::touch(draw::atlas_page page) -> void {
    m_pages.at(std::to_underlying(page)).last_used = m_frame;
}

auto glyph_atlas::write(
    const atlas_slot& slot, std::span<const std::byte> coverage, isize row_pitch
) -> void {
    LUCENT_INVARIANT(is_current(slot));
    const isize width = slot.area.right - slot.area.left;
    const isize height = slot.area.bottom - slot.area.top;
    LUCENT_INVARIANT(
        row_pitch >= width && std::ssize(coverage) >= (row_pitch * (height - 1)) + width
    );
    page& target = m_pages.at(std::to_underlying(slot.page));
    const draw::pixel_rect padded{
        .left = slot.area.left - padding,
        .top = slot.area.top - padding,
        .right = slot.area.right + padding,
        .bottom = slot.area.bottom + padding,
    };
    const std::span<std::byte> texels{target.coverage};
    // The border is cleared too: a page reused after eviction still holds the old glyphs there.
    for (const i32 row : std::views::iota(padded.top, padded.bottom)) {
        const auto line = texels.subspan(
            narrow<usize>((isize{row} * m_page_size) + padded.left),
            narrow<usize>(padded.right - padded.left)
        );
        std::ranges::fill(line, std::byte{0});
    }
    for (const isize row : std::views::iota(isize{0}, height)) {
        const auto source = coverage.subspan(narrow<usize>(row * row_pitch), narrow<usize>(width));
        const isize first = ((slot.area.top + row) * m_page_size) + slot.area.left;
        std::ranges::copy(source, texels.subspan(narrow<usize>(first)).begin());
    }
    target.dirty = united(target.dirty, padded);
}

auto glyph_atlas::take_patches() -> std::vector<draw::atlas_patch> {
    std::vector<draw::atlas_patch> patches;
    for (const auto [index, candidate] : std::views::enumerate(m_pages)) {
        if (candidate.dirty) {
            patches.push_back(patch_of(index, *candidate.dirty));
            candidate.dirty.reset();
        }
    }
    return patches;
}

auto glyph_atlas::every_page() const -> std::vector<draw::atlas_patch> {
    std::vector<draw::atlas_patch> patches;
    for (const auto [index, candidate] : std::views::enumerate(m_pages)) {
        if (candidate.use != page_use::empty) {
            patches.push_back(
                patch_of(index, {.left = 0, .top = 0, .right = m_page_size, .bottom = m_page_size})
            );
        }
    }
    return patches;
}

auto glyph_atlas::evictions() const -> i64 {
    return m_evictions;
}

auto glyph_atlas::place(isize index, draw::pixel_size padded) -> std::optional<atlas_slot> {
    page& target = m_pages.at(narrow<usize>(index));
    shelf* best = nullptr;
    for (shelf& row : target.shelves) {
        const bool has_room = m_page_size - row.used >= padded.width;
        if (has_room
            && is_snug(row.height, padded.height)
            && (best == nullptr || row.height < best->height)) {
            best = &row;
        }
    }
    if (best == nullptr) {
        const i32 height = std::min(shelf_height(padded.height), m_page_size);
        if (target.next_top + height > m_page_size) {
            return std::nullopt;
        }
        target.shelves.push_back({.top = target.next_top, .height = height, .used = 0});
        target.next_top += height;
        best = &target.shelves.back();
    }
    const draw::pixel_rect area{
        .left = best->used + padding,
        .top = best->top + padding,
        .right = best->used + padded.width - padding,
        .bottom = best->top + padded.height - padding,
    };
    best->used += padded.width;
    target.last_used = m_frame;
    return atlas_slot{
        .page = draw::atlas_page{narrow<u16>(index)},
        .generation = target.generation,
        .area = area,
    };
}

// The evictable page used longest ago, never one touched this frame.
auto glyph_atlas::victim() const -> std::optional<isize> {
    std::optional<isize> oldest;
    for (const auto [index, candidate] : std::views::enumerate(m_pages)) {
        const bool can_clear =
            candidate.use == page_use::evictable && candidate.last_used < m_frame;
        if (can_clear
            && (!oldest || candidate.last_used < m_pages.at(narrow<usize>(*oldest)).last_used)) {
            oldest = index;
        }
    }
    return oldest;
}

auto glyph_atlas::clear(isize index) -> void {
    page& target = m_pages.at(narrow<usize>(index));
    ++target.generation;
    target.shelves.clear();
    target.next_top = 0;
    ++m_evictions;
}

auto glyph_atlas::patch_of(isize index, const draw::pixel_rect& area) const -> draw::atlas_patch {
    const page& source = m_pages.at(narrow<usize>(index));
    const isize first = (isize{area.top} * m_page_size) + area.left;
    return {
        .page = draw::atlas_page{narrow<u16>(index)},
        .area = area,
        .coverage = std::span{source.coverage}.subspan(narrow<usize>(first)),
        .row_pitch = m_page_size,
    };
}

}
