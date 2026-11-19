#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <vector>

#include <dwrite_3.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/text/text_layout.hpp>

#include "direct_write.hpp"
#include "text_engine.hpp"
#include "utf16.hpp"

namespace lucent::text {
namespace {

using Microsoft::WRL::ComPtr;

// Far wider and taller than any target, where DirectWrite needs a bound: it refuses infinity.
constexpr f32 unbounded = f32{u32{1} << 24U};
// A COLR layer's palette index that means the text's own colour.
constexpr u16 foreground_palette_index = 0xffff;

auto to_channel(f32 value) -> u8 {
    return narrow<u8>(static_cast<i32>(std::round(std::clamp(value, 0.0F, 1.0F) * 255.0F)));
}

// DWRITE_COLOR_F is a union of spellings for four floats, read here as the floats.
auto to_color(const DWRITE_COLOR_F& value) -> draw::color {
    const auto [red, green, blue, alpha] = std::bit_cast<std::array<f32, 4>>(value);
    return {
        .r = to_channel(red),
        .g = to_channel(green),
        .b = to_channel(blue),
        .a = to_channel(alpha),
    };
}

auto line_metrics(IDWriteTextLayout& made) -> result<std::vector<DWRITE_LINE_METRICS>> {
    UINT32 count = 0;
    const HRESULT sized = made.GetLineMetrics(nullptr, 0, &count);
    if (sized != E_NOT_SUFFICIENT_BUFFER) {
        LUCENT_TRY(checked(sized));
    }
    std::vector<DWRITE_LINE_METRICS> lines(narrow<usize>(count));
    LUCENT_TRY(checked(made.GetLineMetrics(lines.data(), count, &count)));
    return lines;
}

// For each glyph of a run, the UTF-16 cluster it belongs to, from the run's cluster map.
auto clusters_of(const collected_run& run) -> std::vector<std::optional<glyph_cluster>> {
    std::vector<std::optional<glyph_cluster>> clusters(run.glyphs.size());
    if (run.cluster_map.empty()) {
        return clusters;
    }
    const isize length = std::ssize(run.cluster_map);
    isize unit = 0;
    while (unit < length) {
        const u16 first_glyph = run.cluster_map.at(narrow<usize>(unit));
        isize next = unit + 1;
        while (next < length && run.cluster_map.at(narrow<usize>(next)) == first_glyph) {
            ++next;
        }
        const isize end_glyph =
            next < length ? isize{run.cluster_map.at(narrow<usize>(next))} : std::ssize(run.glyphs);
        for (const isize glyph : std::views::iota(isize{first_glyph}, end_glyph)) {
            clusters.at(narrow<usize>(glyph)) = glyph_cluster{
                .begin = run.text_position + unit,
                .end = run.text_position + next,
            };
        }
        unit = next;
    }
    return clusters;
}

// Pens along a run: left to right from its origin, or right to left for an odd bidi level, where
// each glyph's origin is its left edge after stepping back over its advance.
auto append_glyphs(
    const collected_run& run,
    face_id id,
    std::optional<draw::color> layer_color,
    std::optional<glyph_cluster> fallback_cluster,
    placed_text& out
) -> void {
    const bool is_right_to_left = (run.bidi_level & 1U) != 0;
    std::vector<std::optional<glyph_cluster>> clusters = clusters_of(run);
    f32 pen = run.origin.x;
    for (const auto [glyph, advance, offset, cluster] :
        std::views::zip(run.glyphs, run.advances, run.offsets, clusters)) {
        f32 x = 0.0F;
        if (is_right_to_left) {
            pen -= advance;
            x = pen - offset.advanceOffset;
        } else {
            x = pen + offset.advanceOffset;
            pen += advance;
        }
        const std::optional<glyph_cluster> own = cluster ? cluster : fallback_cluster;
        out.glyphs.push_back({
            .face = id,
            .index = glyph,
            .em_size = run.em_size,
            .pen = {.x = x, .y = std::floor(run.origin.y - offset.ascenderOffset + 0.5F)},
            .advance = advance,
            .text_offset = own ? out.utf8_offsets.subspan(narrow<usize>(own->begin)).front() : 0,
            .layer_color = layer_color,
        });
        out.clusters.push_back(own);
    }
}

struct line_text {
    isize begin = 0;
    isize end = 0;
    // Where trailing whitespace starts: past it, glyphs don't count toward the width.
    isize visible_end = 0;
};

auto texts_of(std::span<const DWRITE_LINE_METRICS> metrics) -> std::vector<line_text> {
    std::vector<line_text> texts;
    isize start = 0;
    for (const DWRITE_LINE_METRICS& line : metrics) {
        const isize end = start + isize{line.length};
        texts.push_back({
            .begin = start,
            .end = end,
            .visible_end = end - isize{line.trailingWhitespaceLength},
        });
        start = end;
    }
    if (texts.empty()) {
        texts.push_back({});
    }
    return texts;
}

// Lines are told apart by baseline: uniform spacing puts line i's at i heights plus the baseline.
auto line_of(const placed_glyph& glyph, line_spacing spacing, isize count) -> isize {
    const f32 steps = std::floor(((glyph.pen.y - spacing.baseline) / spacing.height) + 0.5F);
    return std::clamp(static_cast<isize>(steps), isize{0}, count - 1);
}

auto laid_out_lines(
    const layout_request& request,
    line_spacing spacing,
    std::span<const DWRITE_LINE_METRICS> metrics,
    const placed_text& placed
) -> text_layout {
    const std::vector<line_text> texts = texts_of(metrics);
    const isize count = std::ssize(texts);
    const isize kept = request.max_lines ? std::min(count, *request.max_lines) : count;
    const bool is_trimmed = std::ranges::any_of(metrics, [](const DWRITE_LINE_METRICS& line) {
        return line.isTrimmed != FALSE;
    });
    text_layout laid_out{
        .glyphs = {},
        .lines = {},
        .size = {.x = 0.0F, .y = 0.0F},
        .line_height = spacing.height / request.pixels_per_unit,
        .baseline = spacing.baseline / request.pixels_per_unit,
        .pixels_per_unit = request.pixels_per_unit,
        .is_truncated = kept < count || is_trimmed,
    };
    for (const isize line : std::views::iota(isize{0}, kept)) {
        const line_text& text = texts.at(narrow<usize>(line));
        const isize first_glyph = std::ssize(laid_out.glyphs);
        f32 width = 0.0F;
        std::optional<isize> cut_at;
        isize visible_text_end = text.begin;
        for (const auto [glyph, cluster] : std::views::zip(placed.glyphs, placed.clusters)) {
            if (line_of(glyph, spacing, count) != line) {
                continue;
            }
            laid_out.glyphs.push_back(glyph);
            if (!cluster) {
                cut_at = std::ssize(laid_out.glyphs) - 1;
            } else {
                visible_text_end = std::max(visible_text_end, cluster->end);
            }
            if (!cluster || cluster->begin < text.visible_end) {
                width = std::max(width, glyph.pen.x + glyph.advance);
            }
        }
        const isize text_end =
            placed.utf8_offsets.subspan(narrow<usize>(cut_at ? visible_text_end : text.end))
                .front();
        if (cut_at) {
            laid_out.glyphs.at(narrow<usize>(*cut_at)).text_offset = text_end;
            laid_out.is_truncated = true;
        }
        laid_out.lines.push_back({
            .first_glyph = first_glyph,
            .glyph_count = std::ssize(laid_out.glyphs) - first_glyph,
            .text_begin = placed.utf8_offsets.subspan(narrow<usize>(text.begin)).front(),
            .text_end = text_end,
            .width = width / request.pixels_per_unit,
        });
        laid_out.size.x = std::max(laid_out.size.x, width / request.pixels_per_unit);
    }
    laid_out.size.y = laid_out.line_height * static_cast<f32>(kept);
    return laid_out;
}

}

auto text_engine::place_run(const collected_run& run, const std::wstring& wide, placed_text& out)
    -> result<void> {
    const face_id id = LUCENT_TRY(face_of(run.face.Get()));
    if (!face(id).is_color) {
        append_glyphs(run, id, std::nullopt, std::nullopt, out);
        return {};
    }
    const DWRITE_GLYPH_RUN glyph_run{
        .fontFace = run.face.Get(),
        .fontEmSize = run.em_size,
        .glyphCount = narrow<UINT32>(std::ssize(run.glyphs)),
        .glyphIndices = run.glyphs.data(),
        .glyphAdvances = run.advances.data(),
        .glyphOffsets = run.offsets.data(),
        .isSideways = FALSE,
        .bidiLevel = run.bidi_level,
    };
    const DWRITE_GLYPH_RUN_DESCRIPTION description{
        .localeName = nullptr,
        .string = run.cluster_map.empty() ? nullptr : &wide.at(run.text_position),
        .stringLength = narrow<UINT32>(std::ssize(run.cluster_map)),
        .clusterMap = run.cluster_map.empty() ? nullptr : run.cluster_map.data(),
        .textPosition = run.text_position,
    };
    ComPtr<IDWriteColorGlyphRunEnumerator> layers;
    const HRESULT translated = m_factory->TranslateColorGlyphRun(
        run.origin.x,
        run.origin.y,
        &glyph_run,
        run.cluster_map.empty() ? nullptr : &description,
        DWRITE_MEASURING_MODE_NATURAL,
        nullptr,
        0,
        &layers
    );
    if (translated == DWRITE_E_NOCOLOR) {
        append_glyphs(run, id, std::nullopt, std::nullopt, out);
        return {};
    }
    LUCENT_TRY(checked(translated));
    const std::vector<std::optional<glyph_cluster>> base_clusters = clusters_of(run);
    const std::optional<glyph_cluster> first_cluster =
        base_clusters.empty() ? std::nullopt : base_clusters.front();
    while (true) {
        BOOL has_run = FALSE;
        LUCENT_TRY(checked(layers->MoveNext(&has_run)));
        if (has_run == FALSE) {
            return {};
        }
        const DWRITE_COLOR_GLYPH_RUN* layer = nullptr;
        LUCENT_TRY(checked(layers->GetCurrentRun(&layer)));
        const collected_run layer_run = copied_run(
            layer->glyphRun,
            layer->glyphRunDescription,
            {.x = layer->baselineOriginX, .y = layer->baselineOriginY}
        );
        const face_id layer_face = LUCENT_TRY(face_of(layer_run.face.Get()));
        const std::optional<draw::color> color = layer->paletteIndex == foreground_palette_index
                                                     ? std::nullopt
                                                     : std::optional{to_color(layer->runColor)};
        append_glyphs(layer_run, layer_face, color, first_cluster, out);
    }
}

// IDWriteTextLayout set up as the request asks: its width, wrapping, and the ellipsis trimming.
auto text_engine::text_layout_for(
    const layout_request& request,
    const std::wstring& wide,
    IDWriteTextFormat1& format,
    line_spacing spacing
) -> result<ComPtr<IDWriteTextLayout>> {
    const bool uses_width =
        request.wrap == text_wrap::words || request.overflow == text_overflow::ellipsis;
    const bool is_ellipsis = request.overflow == text_overflow::ellipsis;
    // Trimming at a height is how DirectWrite puts the ellipsis on the last line max_lines keeps.
    const f32 max_height = is_ellipsis && request.wrap == text_wrap::words && request.max_lines
                               ? static_cast<f32>(*request.max_lines) * spacing.height
                               : unbounded;
    ComPtr<IDWriteTextLayout> made;
    LUCENT_TRY(checked(m_factory->CreateTextLayout(
        wide.c_str(),
        narrow<UINT32>(std::ssize(wide)),
        &format,
        uses_width ? request.max_width * request.pixels_per_unit : unbounded,
        max_height,
        &made
    )));
    LUCENT_TRY(checked(made->SetWordWrapping(
        request.wrap == text_wrap::words ? DWRITE_WORD_WRAPPING_EMERGENCY_BREAK
                                         : DWRITE_WORD_WRAPPING_NO_WRAP
    )));
    if (is_ellipsis) {
        ComPtr<IDWriteInlineObject> sign;
        LUCENT_TRY(checked(m_factory->CreateEllipsisTrimmingSign(&format, &sign)));
        const DWRITE_TRIMMING trimming{
            .granularity = DWRITE_TRIMMING_GRANULARITY_CHARACTER,
            .delimiter = 0,
            .delimiterCount = 0,
        };
        LUCENT_TRY(checked(made->SetTrimming(&trimming, sign.Get())));
    }
    return made;
}

auto text_engine::shaped_layout(const layout_request& request, const std::wstring& wide)
    -> result<text_layout> {
    const face_id id = request.style.face;
    const f32 em_size = request.style.size * request.pixels_per_unit;
    const line_spacing spacing = spacing_of(id, em_size);
    IDWriteTextFormat1* const format = LUCENT_TRY(format_for(id, em_size, spacing));
    const ComPtr<IDWriteTextLayout> made =
        LUCENT_TRY(text_layout_for(request, wide, *format, spacing));
    glyph_collector collector;
    LUCENT_TRY(checked(made->Draw(nullptr, &collector, 0.0F, 0.0F)));
    const std::vector<collected_run> runs = collector.take_runs();
    const std::vector<DWRITE_LINE_METRICS> metrics = LUCENT_TRY(line_metrics(*made.Get()));

    const std::vector<isize> offsets = utf8_offsets(wide, std::ssize(request.utf8));
    placed_text placed{.glyphs = {}, .clusters = {}, .utf8_offsets = offsets};
    for (const collected_run& run : runs) {
        LUCENT_TRY(place_run(run, wide, placed));
    }
    return laid_out_lines(request, spacing, metrics, placed);
}

}
