#include <algorithm>
#include <numeric>
#include <optional>
#include <ranges>
#include <span>
#include <string_view>
#include <vector>

#include <dwrite_3.h>

#include <lucent/core/narrow.hpp>
#include <lucent/text/text_layout.hpp>

#include "direct_write.hpp"
#include "text_engine.hpp"
#include "utf16.hpp"

namespace lucent::text {
namespace {

constexpr u32 ellipsis_code_point = 0x2026;

// Clusters [begin, end): for the fast path one UTF-16 unit, one glyph.
struct cluster_span {
    isize begin = 0;
    isize end = 0;
};

auto is_space(wchar_t unit) -> bool {
    return unit == L' ';
}

auto sum(std::span<const f32> advances, cluster_span span) -> f32 {
    const auto part =
        advances.subspan(narrow<usize>(span.begin), narrow<usize>(span.end - span.begin));
    return std::accumulate(part.begin(), part.end(), 0.0F);
}

// Where the line's ink ends: trailing spaces hang past its width.
auto visible_end(std::wstring_view wide, cluster_span line) -> isize {
    isize end = line.end;
    while (end > line.begin && is_space(wide.at(narrow<usize>(end - 1)))) {
        --end;
    }
    return end;
}

// Where the line starting at start ends: after the last space run that lets it fit, or, for a
// word wider than the line on its own, before the first cluster that doesn't fit (keeping one).
auto line_end(std::wstring_view wide, std::span<const f32> advances, isize start, f32 max_width)
    -> isize {
    const auto first = narrow<usize>(start);
    f32 pen = 0.0F;
    isize last_break = start;
    bool was_space = false;
    for (const auto [index, unit, advance] :
        std::views::zip(std::views::iota(start), wide.substr(first), advances.subspan(first))) {
        if (is_space(unit)) {
            pen += advance;
            was_space = true;
            continue;
        }
        if (was_space) {
            last_break = index;
            was_space = false;
        }
        if (pen + advance > max_width && index > start) {
            return last_break > start ? last_break : index;
        }
        pen += advance;
    }
    return std::ssize(wide);
}

// IDWriteTextLayout's EMERGENCY_BREAK on text whose only break opportunities follow spaces.
auto broken_lines(std::wstring_view wide, std::span<const f32> advances, f32 max_width)
    -> std::vector<cluster_span> {
    std::vector<cluster_span> lines;
    isize start = 0;
    while (start < std::ssize(wide)) {
        const isize end = line_end(wide, advances, start, max_width);
        lines.push_back({.begin = start, .end = end});
        start = end;
    }
    return lines;
}

// The clusters kept before an ellipsis: as many as fit with it in max_width, then without the
// spaces they end in, as DirectWrite's character trimming leaves them.
auto trimmed_end(
    std::wstring_view wide,
    std::span<const f32> advances,
    cluster_span line,
    f32 max_width,
    f32 ellipsis
) -> isize {
    isize end = line.end;
    f32 width = sum(advances, line);
    while (end > line.begin && width + ellipsis > max_width) {
        --end;
        width -= advances.subspan(narrow<usize>(end)).front();
    }
    return visible_end(wide, {.begin = line.begin, .end = end});
}

// How the clusters fall into lines, before any glyph is placed.
struct line_plan {
    std::vector<cluster_span> lines;
    bool has_hidden_lines = false;
    bool wants_ellipsis = false;
};

auto planned(const layout_request& request, std::wstring_view wide, std::span<const f32> advances)
    -> std::optional<line_plan> {
    const f32 max_width = request.max_width * request.pixels_per_unit;
    const cluster_span whole{.begin = 0, .end = std::ssize(wide)};
    const bool must_wrap =
        request.wrap == text_wrap::words
        && sum(advances, {.begin = 0, .end = visible_end(wide, whole)}) > max_width;
    if (must_wrap && !std::ranges::all_of(wide, is_wrap_safe_unit)) {
        return std::nullopt;
    }
    line_plan plan{
        .lines =
            must_wrap ? broken_lines(wide, advances, max_width) : std::vector<cluster_span>{whole},
        .has_hidden_lines = false,
        .wants_ellipsis = false,
    };
    plan.has_hidden_lines = request.max_lines && std::ssize(plan.lines) > *request.max_lines;
    if (plan.has_hidden_lines) {
        plan.lines.resize(narrow<usize>(*request.max_lines));
    }
    const cluster_span& last = plan.lines.back();
    const bool is_too_wide =
        sum(advances, {.begin = last.begin, .end = visible_end(wide, last)}) > max_width;
    plan.wants_ellipsis =
        request.overflow == text_overflow::ellipsis
        && (plan.has_hidden_lines || (request.wrap == text_wrap::none && is_too_wide));
    return plan;
}

// What every line of one fast layout shares.
struct line_source {
    face_id face{};
    f32 em_size = 0.0F;
    f32 max_width = 0.0F;
    line_spacing spacing;
    std::wstring_view wide;
    std::span<const u16> glyphs;
    std::span<const f32> advances;
    std::span<const isize> utf8_offsets;
};

auto add_line(
    text_layout& laid_out,
    const line_source& source,
    cluster_span line,
    std::optional<ellipsis_glyph> ellipsis
) -> void {
    const isize end =
        ellipsis
            ? trimmed_end(source.wide, source.advances, line, source.max_width, ellipsis->advance)
            : line.end;
    const f32 baseline = (static_cast<f32>(std::ssize(laid_out.lines)) * source.spacing.height)
                         + source.spacing.baseline;
    const isize first_glyph = std::ssize(laid_out.glyphs);
    const auto kept = std::views::iota(narrow<usize>(line.begin), narrow<usize>(end));
    f32 pen = 0.0F;
    for (const usize cluster : kept) {
        const f32 advance = source.advances.subspan(cluster).front();
        laid_out.glyphs.push_back({
            .face = source.face,
            .index = source.glyphs.subspan(cluster).front(),
            .em_size = source.em_size,
            .pen = {.x = pen, .y = baseline},
            .advance = advance,
            .text_offset = source.utf8_offsets.subspan(cluster).front(),
            .layer_color = std::nullopt,
        });
        pen += advance;
    }
    f32 width = ellipsis ? pen
                         : sum(source.advances,
                               {.begin = line.begin, .end = visible_end(source.wide, line)});
    if (ellipsis) {
        laid_out.glyphs.push_back({
            .face = source.face,
            .index = ellipsis->index,
            .em_size = source.em_size,
            .pen = {.x = pen, .y = baseline},
            .advance = ellipsis->advance,
            .text_offset = source.utf8_offsets.subspan(narrow<usize>(end)).front(),
            .layer_color = std::nullopt,
        });
        width += ellipsis->advance;
    }
    const f32 units_wide = width / laid_out.pixels_per_unit;
    laid_out.lines.push_back({
        .first_glyph = first_glyph,
        .glyph_count = std::ssize(laid_out.glyphs) - first_glyph,
        .text_begin = source.utf8_offsets.subspan(narrow<usize>(line.begin)).front(),
        .text_end = source.utf8_offsets.subspan(narrow<usize>(end)).front(),
        .width = units_wide,
    });
    laid_out.size.x = std::max(laid_out.size.x, units_wide);
}

}

// The string's glyphs from the face's cmap, with design advances plus pair kerning. Absent when
// IDWriteTextLayout would do more: a glyph is missing (fallback), substitutable, or a pair shapes
// to more than a kerning adjustment.
auto text_engine::simple_glyphs(face_id id, std::wstring_view wide)
    -> result<std::optional<simple_run>> {
    std::vector<UINT32> code_points;
    code_points.reserve(wide.size());
    for (const wchar_t unit : wide) {
        code_points.push_back(u32{unit});
    }
    simple_run run{.glyphs = std::vector<u16>(wide.size()), .advances = {}};
    LUCENT_TRY(checked(face(id).face->GetGlyphIndices(
        code_points.data(), narrow<UINT32>(std::ssize(code_points)), run.glyphs.data()
    )));
    if (std::ranges::contains(run.glyphs, u16{0})) {
        return std::nullopt;
    }
    for (const u16 glyph : run.glyphs) {
        if (LUCENT_TRY(is_substitutable(id, glyph))) {
            return std::nullopt;
        }
    }
    run.advances = LUCENT_TRY(design_advances(id, run.glyphs));
    const std::vector<i32> unshaped = run.advances;
    // A lone character is shaped alone, for the substitutions a pair would have shown.
    const usize width = wide.size() == 1 ? 1 : 2;
    const isize pairs = wide.size() == 1 ? 1 : std::max(std::ssize(wide) - 1, isize{0});
    for (const isize first : std::views::iota(isize{0}, pairs)) {
        const auto position = narrow<usize>(first);
        const std::optional<i32> kerning = LUCENT_TRY(kerning_of(
            id,
            wide.substr(position, width),
            std::span{run.glyphs}.subspan(position, width),
            std::span{unshaped}.subspan(position, width)
        ));
        if (!kerning) {
            return std::nullopt;
        }
        run.advances.at(position) += *kerning;
    }
    return run;
}

auto text_engine::ellipsis_for(face_id id, f32 scale) -> result<std::optional<ellipsis_glyph>> {
    u16 index = 0;
    LUCENT_TRY(checked(face(id).face->GetGlyphIndices(&ellipsis_code_point, 1, &index)));
    if (index == 0) {
        return std::nullopt;
    }
    const std::vector<i32> design = LUCENT_TRY(design_advances(id, {&index, 1}));
    return ellipsis_glyph{.index = index, .advance = static_cast<f32>(design.front()) * scale};
}

auto text_engine::fast_layout(const layout_request& request, std::wstring_view wide)
    -> result<std::optional<text_layout>> {
    const face_id id = request.style.face;
    if (!std::ranges::all_of(wide, is_simple_unit) || face(id).is_color) {
        return std::nullopt;
    }
    const std::optional<simple_run> simple = LUCENT_TRY(simple_glyphs(id, wide));
    if (!simple) {
        return std::nullopt;
    }
    const f32 em_size = request.style.size * request.pixels_per_unit;
    const f32 scale = em_size / face(id).metrics.units_per_em;
    std::vector<f32> advances;
    advances.reserve(simple->advances.size());
    for (const i32 advance : simple->advances) {
        advances.push_back(static_cast<f32>(advance) * scale);
    }
    const std::optional<line_plan> plan = planned(request, wide, advances);
    if (!plan) {
        return std::nullopt;
    }
    std::optional<ellipsis_glyph> ellipsis;
    if (plan->wants_ellipsis) {
        ellipsis = LUCENT_TRY(ellipsis_for(id, scale));
        if (!ellipsis) {
            return std::nullopt;
        }
    }

    const std::vector<isize> offsets = utf8_offsets(wide, std::ssize(request.utf8));
    const line_source source{
        .face = id,
        .em_size = em_size,
        .max_width = request.max_width * request.pixels_per_unit,
        .spacing = spacing_of(id, em_size),
        .wide = wide,
        .glyphs = simple->glyphs,
        .advances = advances,
        .utf8_offsets = offsets,
    };
    text_layout laid_out{
        .glyphs = {},
        .lines = {},
        .size = {.x = 0.0F, .y = 0.0F},
        .line_height = source.spacing.height / request.pixels_per_unit,
        .baseline = source.spacing.baseline / request.pixels_per_unit,
        .pixels_per_unit = request.pixels_per_unit,
        .is_truncated = plan->has_hidden_lines || plan->wants_ellipsis,
    };
    for (const cluster_span& line : plan->lines) {
        const bool is_last = &line == &plan->lines.back();
        add_line(laid_out, source, line, is_last ? ellipsis : std::nullopt);
    }
    laid_out.size.y = laid_out.line_height * static_cast<f32>(std::ssize(laid_out.lines));
    return laid_out;
}

}
