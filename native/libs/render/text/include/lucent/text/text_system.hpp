#pragma once

#include <cstddef>
#include <memory>
#include <span>
#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>

namespace lucent::text {

struct text_options {
    // Glyphs rasterized per frame by draw(); one past the budget draws a frame later.
    isize raster_budget = 64;
    // Frames a layout stays cached without being asked for.
    i64 layout_lifetime = 4;
    atlas_limits atlas;
};

// Coverage for an icon: one byte a pixel, rows row_pitch bytes apart. Borrowed for the call.
struct icon_pixels {
    draw::pixel_size size;
    std::span<const std::byte> coverage;
    isize row_pitch = 0;
};

// An icon on a pinned page: drawn as one quad of this size in pixels, tinted.
struct icon {
    draw::atlas_page page{};
    draw::rect uv;
    draw::pixel_size size;
};

// Fonts, shaping, fallback, rasterization and the glyph atlas, through DirectWrite from a factory
// of its own (an isolated one: nothing it registers is seen by, or depends on, the host's).
// Strings in are UTF-8, converted at the DirectWrite boundary.
//
// Threads: the render thread only, all of it. Everything it returns that borrows (a layout, the
// atlas patches) stays valid until the next begin_frame().
class text_system final {
public:
    static auto create(const text_options& options) -> result<text_system>;

    text_system(const text_system&) = delete ("it owns a DirectWrite factory and the atlas");
    auto operator=(const text_system&)
        -> text_system& = delete ("it owns a DirectWrite factory and the atlas");
    text_system(text_system&& other) noexcept;
    auto operator=(text_system&& other) noexcept -> text_system&;
    ~text_system();

    // OpenType, TrueType, WOFF or WOFF2 bytes, copied. The first face of a collection file.
    // Adding a face or setting the fallback drops every cached layout, borrowed ones included.
    auto add_face(std::span<const std::byte> bytes) -> result<face_id>;
    // Ours to try, in order, for what a style's face lacks; the system's fallback follows them.
    auto set_fallback(std::span<const face_id> chain) -> result<void>;

    // Drops layouts not asked for lately and opens the atlas's frame.
    auto begin_frame() -> void;

    auto layout(const layout_request& request) -> result<const text_layout*>;
    // Glyphs over this frame's raster budget are left out and drawn once rasterized.
    auto draw(
        draw::draw_list& list, const text_layout& laid_out, draw::vec2 origin, draw::color tint
    ) -> result<void>;
    // Rasterizes every glyph of the text now, outside the budget: what the UI knows it shows.
    auto prewarm(const layout_request& request) -> result<void>;

    // Pinned: never evicted, for the text system's life.
    auto add_icon(const icon_pixels& pixels) -> result<icon>;
    auto draw(draw::draw_list& list, const icon& drawn, draw::vec2 origin, draw::color tint)
        -> void;

    // The atlas changes since the last call, for the renderer's upload_atlas.
    auto take_patches() -> std::vector<atlas_patch>;
    // Every page in use, for a new device.
    auto every_page() const -> std::vector<atlas_patch>;
    auto evictions() const -> i64;

private:
    struct state;

    explicit text_system(std::unique_ptr<state> owned);

    std::unique_ptr<state> m_state;
};

}
