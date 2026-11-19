#pragma once

#include <cstddef>
#include <flat_map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <dwrite_3.h>
#include <wrl/client.h>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "direct_write.hpp"

namespace lucent::text {

// Which way a layout was made. The fast path refuses text it can't lay out exactly as
// IDWriteTextLayout would.
enum class layout_path : u8 {
    fast,
    shaped,
};

// A face's vertical metrics, in its design units.
struct face_metrics {
    f32 units_per_em = 0.0F;
    f32 ascent = 0.0F;
    f32 descent = 0.0F;
    f32 line_gap = 0.0F;
};

// What a text format names one of our faces by in our collection.
struct face_name {
    std::wstring family;
    DWRITE_FONT_WEIGHT weight = DWRITE_FONT_WEIGHT_NORMAL;
    DWRITE_FONT_STYLE style = DWRITE_FONT_STYLE_NORMAL;
    DWRITE_FONT_STRETCH stretch = DWRITE_FONT_STRETCH_NORMAL;
};

struct known_face {
    Microsoft::WRL::ComPtr<IDWriteFontFace3> face;
    // Ours only; a system face fallback found has none.
    std::optional<face_name> name;
    face_metrics metrics;
    bool is_color = false;
    // The fast path's, by glyph index and filled as glyphs are first met: design advances, and
    // whether a contextual substitution covers the glyph.
    std::vector<std::optional<i32>> advances;
    std::vector<std::optional<bool>> substitutable;
    // By (glyph count << 32 | first glyph << 16 | last glyph), for one glyph or a pair: the kerning
    // shaping adds to the first, in design units, absent where shaping does more than kern.
    std::flat_map<u64, std::optional<i32>> kerning;
};

struct glyph_key {
    face_id face{};
    u16 index = 0;
    f32 em_size = 0.0F;
    u8 phase = 0;

    auto operator<=>(const glyph_key&) const = default;
};

// A rasterized glyph: where its ink sits from the pen (whole pixels, at its phase) and where the
// atlas holds it. No slot means no ink (a space), which is never drawn.
struct glyph_entry {
    draw::pixel_rect bounds;
    std::optional<atlas_slot> slot;
};

struct layout_key {
    std::string utf8;
    face_id face{};
    f32 size = 0.0F;
    f32 max_width = 0.0F;
    text_wrap wrap = text_wrap::none;
    text_overflow overflow = text_overflow::visible;
    std::optional<isize> max_lines;
    f32 pixels_per_unit = 0.0F;
};

struct layout_key_view {
    std::string_view utf8;
    face_id face{};
    f32 size = 0.0F;
    f32 max_width = 0.0F;
    text_wrap wrap = text_wrap::none;
    text_overflow overflow = text_overflow::visible;
    std::optional<isize> max_lines;
    f32 pixels_per_unit = 0.0F;
};

// Orders keys and views of them alike, so a lookup needn't copy the string.
struct layout_order {
    using is_transparent = void;

    auto operator()(const layout_key& left, const layout_key& right) const -> bool;
    auto operator()(const layout_key& left, const layout_key_view& right) const -> bool;
    auto operator()(const layout_key_view& left, const layout_key& right) const -> bool;
};

struct cached_layout {
    std::unique_ptr<text_layout> laid_out;
    i64 last_used = 0;
};

struct format_key {
    face_id face{};
    f32 em_size = 0.0F;

    auto operator<=>(const format_key&) const = default;
};

// Every line of a layout is this tall, with its baseline this far down, in whole pixels.
struct line_spacing {
    f32 height = 0.0F;
    f32 baseline = 0.0F;
};

// A simple string's glyphs, one per UTF-16 unit, and their kerned design advances.
struct simple_run {
    std::vector<u16> glyphs;
    std::vector<i32> advances;
};

// The face's own ellipsis, for the fast path's trimming.
struct ellipsis_glyph {
    u16 index = 0;
    f32 advance = 0.0F;
};

// Whether draw may rasterize past the frame's budget.
enum class raster_policy : u8 {
    budgeted,
    unbudgeted,
};

// The DirectWrite objects an engine is made from, every one of which can fail to be made.
struct engine_parts {
    Microsoft::WRL::ComPtr<IDWriteFactory5> factory;
    Microsoft::WRL::ComPtr<IDWriteInMemoryFontFileLoader> loader;
    Microsoft::WRL::ComPtr<IDWriteFontFallback> system_fallback;
    Microsoft::WRL::ComPtr<IDWriteTextAnalyzer2> analyzer;
    DWRITE_SCRIPT_ANALYSIS latin{};
};

// A glyph's UTF-16 cluster, for the lines it is sorted into.
struct glyph_cluster {
    isize begin = 0;
    isize end = 0;
};

// The shaped path's glyphs before they are sorted into lines, each with its cluster (absent for
// the trimming sign's ellipsis, which stands for no text).
struct placed_text {
    std::vector<placed_glyph> glyphs;
    std::vector<std::optional<glyph_cluster>> clusters;
    std::span<const isize> utf8_offsets;
};

// Everything text_system does, behind its public face; tests reach the two layout paths here.
class text_engine final {
public:
    static auto create(const text_options& options) -> result<std::unique_ptr<text_engine>>;

    text_engine(const text_options& options, engine_parts parts);
    text_engine(const text_engine&) = delete ("it owns a DirectWrite factory and the atlas");
    auto operator=(const text_engine&)
        -> text_engine& = delete ("it owns a DirectWrite factory and the atlas");
    text_engine(text_engine&&) = delete ("text_system moves its pointer instead");
    auto operator=(text_engine&&)
        -> text_engine& = delete ("text_system moves its pointer instead");
    ~text_engine() = default;

    auto add_face(std::span<const std::byte> bytes) -> result<face_id>;
    auto set_fallback(std::span<const face_id> chain) -> result<void>;
    auto is_ours(face_id face) const -> bool;

    auto begin_frame() -> void;
    auto layout(const layout_request& request) -> result<const text_layout*>;
    // The fast path's answer is absent when it refuses the text.
    auto layout_by(const layout_request& request, layout_path path)
        -> result<std::optional<text_layout>>;
    auto draw(
        draw::draw_list& list, const text_layout& laid_out, draw::vec2 origin, draw::color tint
    ) -> result<void>;
    auto prewarm(const layout_request& request) -> result<void>;
    auto add_icon(const icon_pixels& pixels) -> result<icon>;
    auto draw(draw::draw_list& list, const icon& drawn, draw::vec2 origin, draw::color tint)
        -> void;

    auto atlas() -> glyph_atlas&;
    auto atlas() const -> const glyph_atlas&;

private:
    auto face(face_id id) -> known_face&;
    auto face_of(IDWriteFontFace* found) -> result<face_id>;
    auto register_face(
        Microsoft::WRL::ComPtr<IDWriteFontFace3> found, std::optional<face_name> name
    ) -> face_id;
    auto rebuild_collection() -> result<void>;
    auto rebuild_fallback() -> result<void>;
    auto format_for(face_id id, f32 em_size, line_spacing spacing) -> result<IDWriteTextFormat1*>;
    auto spacing_of(face_id id, f32 em_size) -> line_spacing;

    auto simple_glyphs(face_id id, std::wstring_view wide) -> result<std::optional<simple_run>>;
    auto ellipsis_for(face_id id, f32 scale) -> result<std::optional<ellipsis_glyph>>;
    auto fast_layout(const layout_request& request, std::wstring_view wide)
        -> result<std::optional<text_layout>>;
    auto text_layout_for(
        const layout_request& request,
        const std::wstring& wide,
        IDWriteTextFormat1& format,
        line_spacing spacing
    ) -> result<Microsoft::WRL::ComPtr<IDWriteTextLayout>>;
    auto shaped_layout(const layout_request& request, const std::wstring& wide)
        -> result<text_layout>;
    auto place_run(const collected_run& run, const std::wstring& wide, placed_text& out)
        -> result<void>;
    auto design_advances(face_id id, std::span<const u16> glyphs) -> result<std::vector<i32>>;
    auto is_substitutable(face_id id, u16 glyph) -> result<bool>;
    auto kerning_of(
        face_id id,
        std::wstring_view text,
        std::span<const u16> glyphs,
        std::span<const i32> advances
    ) -> result<std::optional<i32>>;
    auto resolved_face(const face_name& name) -> result<Microsoft::WRL::ComPtr<IDWriteFontFace3>>;

    // Absent when the glyph can't be drawn this frame: over budget, or the atlas is full.
    auto entry_for(const glyph_key& key, raster_policy policy) -> result<const glyph_entry*>;
    auto rasterize(const glyph_key& key) -> result<std::optional<glyph_entry>>;

    text_options m_options;
    Microsoft::WRL::ComPtr<IDWriteFactory5> m_factory;
    Microsoft::WRL::ComPtr<IDWriteInMemoryFontFileLoader> m_loader;
    Microsoft::WRL::ComPtr<IDWriteFontFallback> m_system_fallback;
    Microsoft::WRL::ComPtr<IDWriteTextAnalyzer2> m_analyzer;
    DWRITE_SCRIPT_ANALYSIS m_latin{};
    Microsoft::WRL::ComPtr<IDWriteFontCollection1> m_collection;
    Microsoft::WRL::ComPtr<IDWriteFontFallback> m_fallback;
    std::vector<Microsoft::WRL::ComPtr<IDWriteFontFile>> m_files;
    std::vector<known_face> m_faces;
    std::vector<face_id> m_chain;
    std::flat_map<format_key, Microsoft::WRL::ComPtr<IDWriteTextFormat1>> m_formats;
    std::flat_map<layout_key, cached_layout, layout_order> m_layouts;
    std::flat_map<glyph_key, glyph_entry> m_glyphs;
    glyph_atlas m_atlas;
    i64 m_frame = 0;
    isize m_rasterized = 0;
    std::vector<draw::glyph_quad> m_quads;
    std::vector<u8> m_raster_scratch;
};

}
