#include <lucent/ui/text_field.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <initializer_list>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/core/flags.hpp>
#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/clipboard.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/edit_buffer.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/text_spec.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {
namespace {

auto units(f32 pixels, const text::text_layout& laid_out) -> f32 {
    return pixels / laid_out.pixels_per_unit;
}

auto glyph_x(const text::placed_glyph& glyph, const text::text_layout& laid_out) -> f32 {
    return units(glyph.pen.x, laid_out);
}

auto glyphs_of(const text::text_layout& laid_out, const text::text_line& line)
    -> std::span<const text::placed_glyph> {
    return std::span{laid_out.glyphs}.subspan(
        narrow<usize>(line.first_glyph), narrow<usize>(line.glyph_count)
    );
}

auto line_end_x(const text::text_layout& laid_out, const text::text_line& line) -> f32 {
    const std::span<const text::placed_glyph> glyphs = glyphs_of(laid_out, line);
    if (glyphs.empty()) {
        return 0.0F;
    }
    return glyph_x(glyphs.back(), laid_out) + units(glyphs.back().advance, laid_out);
}

// The line a caret at offset is on: the last whose text starts at or before it.
auto line_of(const text::text_layout& laid_out, isize offset) -> isize {
    isize found = 0;
    for (const auto [index, line] : std::views::enumerate(laid_out.lines)) {
        if (line.text_begin <= offset) {
            found = index;
        }
    }
    return found;
}

// Control characters other than the line break can't be typed, so they don't arrive pasted.
auto cleaned(std::string_view pasted, text_lines lines) -> std::string {
    std::string kept;
    kept.reserve(pasted.size());
    for (const char unit : pasted) {
        const auto byte = static_cast<u8>(unit);
        if (unit == '\n') {
            kept.push_back(lines == text_lines::multiple ? '\n' : ' ');
        } else if (byte >= 0x20U && byte != 0x7fU) {
            kept.push_back(unit);
        }
    }
    return kept;
}

// What a frame's editing works from: the field's buffer and the text laid out as it stands.
struct editing {
    context* frame = nullptr;
    field_memory* memory = nullptr;
    const text_field_spec* spec = nullptr;
    // The width the text wraps at; ignored for a single line.
    f32 wrap_width = 0.0F;
    bool is_submitted = false;
};

auto text_of(const editing& edit, std::string_view utf8) -> text_spec {
    const theme& tokens = edit.frame->tokens();
    const bool is_multiple = edit.spec->lines == text_lines::multiple;
    return {
        .utf8 = utf8,
        .style = tokens.type.body,
        .ink = tokens.colors.ink,
        .wrap = is_multiple ? text::text_wrap::words : text::text_wrap::none,
        .overflow = text::text_overflow::visible,
        .max_lines = std::nullopt,
    };
}

// The buffer's text laid out; null when the text system fails, which leaves the caret where it is.
auto laid_out_now(const editing& edit) -> const text::text_layout* {
    const result<const text::text_layout*> laid_out =
        edit.frame->measure(text_of(edit, edit.memory->buffer.text()), edit.wrap_width);
    return laid_out ? *laid_out : nullptr;
}

auto selection_mode_of(const input_snapshot& input) -> selection_mode {
    return input.modifiers.has(modifier::shift) ? selection_mode::extend : selection_mode::move;
}

auto step_of(const input_snapshot& input) -> caret_step {
    return input.modifiers.has(modifier::control) ? caret_step::word : caret_step::character;
}

// Up or Down a line, keeping the caret's x.
auto move_line(const editing& edit, isize direction) -> void {
    edit_buffer& buffer = edit.memory->buffer;
    const text::text_layout* const laid_out = laid_out_now(edit);
    if (laid_out == nullptr || laid_out->lines.empty()) {
        return;
    }
    const isize line = line_of(*laid_out, buffer.selection().caret) + direction;
    if (line < 0 || line >= std::ssize(laid_out->lines)) {
        buffer.move_to(
            direction < 0 ? 0 : std::ssize(buffer.text()), selection_mode_of(edit.frame->input())
        );
        return;
    }
    const draw::vec2 caret = caret_point(*laid_out, buffer.selection().caret);
    const f32 middle = (static_cast<f32>(line) + 0.5F) * laid_out->line_height;
    buffer.move_to(
        offset_at(*laid_out, {.x = caret.x, .y = middle}), selection_mode_of(edit.frame->input())
    );
}

// Home or End: the line's start or end in a multi-line field, the text's otherwise.
auto move_to_edge(const editing& edit, isize direction) -> void {
    edit_buffer& buffer = edit.memory->buffer;
    const input_snapshot& input = edit.frame->input();
    const isize whole = direction < 0 ? 0 : std::ssize(buffer.text());
    const text::text_layout* const laid_out =
        edit.spec->lines == text_lines::multiple && !input.modifiers.has(modifier::control)
            ? laid_out_now(edit)
            : nullptr;
    if (laid_out == nullptr || laid_out->lines.empty()) {
        buffer.move_to(whole, selection_mode_of(input));
        return;
    }
    const text::text_line& line =
        laid_out->lines.at(narrow<usize>(line_of(*laid_out, buffer.selection().caret)));
    const f32 middle = laid_out->line_height / 2.0F;
    const f32 top = caret_point(*laid_out, line.text_begin).y;
    const f32 x = direction < 0 ? 0.0F : line_end_x(*laid_out, line);
    buffer.move_to(offset_at(*laid_out, {.x = x, .y = top + middle}), selection_mode_of(input));
}

auto copy_selection(const editing& edit) -> void {
    clipboard* const shared = edit.frame->system_clipboard();
    const std::string_view selected = edit.memory->buffer.selected();
    if (shared != nullptr && !selected.empty()) {
        shared->put_text(selected);
    }
}

auto paste(const editing& edit) -> void {
    const clipboard* const shared = edit.frame->system_clipboard();
    if (shared == nullptr) {
        return;
    }
    if (const std::optional<std::string> pasted = shared->text()) {
        edit.memory->buffer.paste(cleaned(*pasted, edit.spec->lines));
    }
}

// Shortcuts with Control held; whether the key was one.
auto take_shortcut(const editing& edit, key_code code) -> bool {
    edit_buffer& buffer = edit.memory->buffer;
    const bool is_shifted = edit.frame->input().modifiers.has(modifier::shift);
    switch (code) {
    case key_code::letter_a:
        buffer.select_all();
        return true;
    case key_code::letter_c:
        copy_selection(edit);
        return true;
    case key_code::letter_x:
        copy_selection(edit);
        buffer.erase_backward(caret_step::character);
        return true;
    case key_code::letter_v:
        paste(edit);
        return true;
    case key_code::letter_z:
        if (is_shifted) {
            buffer.redo();
        } else {
            buffer.undo();
        }
        return true;
    case key_code::letter_y:
        buffer.redo();
        return true;
    case key_code::tab:
    case key_code::enter:
    case key_code::space:
    case key_code::escape:
    case key_code::backspace:
    case key_code::forward_delete:
    case key_code::left:
    case key_code::right:
    case key_code::up:
    case key_code::down:
    case key_code::home:
    case key_code::end:
    case key_code::page_up:
    case key_code::page_down:
        return false;
    }
    LUCENT_UNREACHABLE();
}

auto take_key(editing& edit, key_event event) -> void {
    if (event.action == key_action::released) {
        return;
    }
    edit_buffer& buffer = edit.memory->buffer;
    const input_snapshot& input = edit.frame->input();
    if (input.modifiers.has(modifier::control) && take_shortcut(edit, event.code)) {
        return;
    }
    switch (event.code) {
    case key_code::backspace:
        buffer.erase_backward(step_of(input));
        return;
    case key_code::forward_delete:
        buffer.erase_forward(step_of(input));
        return;
    case key_code::left:
    case key_code::right:
        buffer.move_caret(
            event.code == key_code::left ? -1 : 1, step_of(input), selection_mode_of(input)
        );
        return;
    case key_code::up:
    case key_code::down:
        if (edit.spec->lines == text_lines::multiple) {
            move_line(edit, event.code == key_code::up ? -1 : 1);
        }
        return;
    case key_code::home:
    case key_code::end:
        move_to_edge(edit, event.code == key_code::home ? -1 : 1);
        return;
    case key_code::enter:
        if (edit.spec->lines == text_lines::multiple) {
            buffer.insert("\n");
        } else if (event.action == key_action::pressed) {
            edit.is_submitted = true;
        }
        return;
    case key_code::tab:
    case key_code::space:
    case key_code::escape:
    case key_code::page_up:
    case key_code::page_down:
    case key_code::letter_a:
    case key_code::letter_c:
    case key_code::letter_v:
    case key_code::letter_x:
    case key_code::letter_y:
    case key_code::letter_z:
        // Space arrives as typed text too; the rest are the context's or nobody's.
        return;
    }
}

auto take_keyboard(editing& edit) -> void {
    for (const keyboard_event& event : edit.frame->input().keyboard) {
        match(
            event,
            [&](const key_event& key) { take_key(edit, key); },
            [&](const typed_text& typed) {
                edit.memory->buffer.insert(cleaned(typed.utf8, edit.spec->lines));
            },
            [&](const composition& update) { edit.memory->buffer.compose(update); }
        );
    }
}

// The text's top left inside the field's inner box, before scrolling.
auto content_origin(const draw::rect& inner, f32 text_height, text_lines lines) -> draw::vec2 {
    if (lines == text_lines::multiple) {
        return inner.min;
    }
    return {
        .x = inner.min.x,
        .y = inner.min.y + ((inner.max.y - inner.min.y - text_height) / 2.0F),
    };
}

auto take_pointer(
    const editing& edit,
    const interaction& hit,
    const draw::rect& inner,
    const text::text_layout& laid_out
) -> void {
    if (!hit.is_pressed || !hit.cursor) {
        return;
    }
    edit_buffer& buffer = edit.memory->buffer;
    const input_snapshot& input = edit.frame->input();
    const draw::vec2 origin = content_origin(inner, laid_out.size.y, edit.spec->lines);
    const draw::vec2 local = *hit.cursor - origin + edit.memory->scroll;
    const isize offset = offset_at(laid_out, local);
    if (!hit.is_just_pressed) {
        if (edit.memory->press_clicks < 2) {
            buffer.move_to(offset, selection_mode::extend);
        }
        return;
    }
    edit.memory->press_clicks = input.left.click_count;
    switch (input.left.click_count) {
    case 2:
        buffer.select_word_at(offset);
        return;
    case 3:
        buffer.select_all();
        return;
    default:
        buffer.move_to(offset, selection_mode_of(input));
        return;
    }
}

// Scrolls just enough to show the caret, and no further than the text runs.
auto reveal_caret(
    field_memory& memory, const text::text_layout& laid_out, draw::vec2 view, const theme& tokens
) -> void {
    const draw::vec2 caret = caret_point(laid_out, memory.buffer.selection().caret);
    const f32 caret_width = tokens.controls.caret_width;
    const f32 line = laid_out.line_height;
    draw::vec2& scroll = memory.scroll;
    if (caret.x + caret_width - scroll.x > view.x) {
        scroll.x = caret.x + caret_width - view.x;
    }
    scroll.x = std::min(scroll.x, caret.x);
    if (caret.y + line - scroll.y > view.y) {
        scroll.y = caret.y + line - view.y;
    }
    scroll.y = std::min(scroll.y, caret.y);
    scroll.x = std::clamp(scroll.x, 0.0F, std::max(laid_out.size.x + caret_width - view.x, 0.0F));
    scroll.y = std::clamp(scroll.y, 0.0F, std::max(laid_out.size.y - view.y, 0.0F));
}

// What the marks under the text draw, from the layout's top left, copied out of the frame.
struct field_marks {
    std::vector<draw::rect> selection;
    std::optional<draw::rect> caret;
    std::optional<draw::rect> underline;
    draw::color selection_tint;
    draw::color caret_tint;
};

auto draw_marks(draw::draw_list& list, const draw::rect& area, const field_marks& marks) -> void {
    const auto placed = [&area](const draw::rect& local) {
        return draw::rect{.min = area.min + local.min, .max = area.min + local.max};
    };
    for (const draw::rect& band : marks.selection) {
        list.fill(
            draw::rounded_rect{.bounds = placed(band), .radii = draw::uniform(0.0F)},
            draw::solid(marks.selection_tint)
        );
    }
    for (const std::optional<draw::rect>& bar : {marks.underline, marks.caret}) {
        if (bar) {
            list.fill(
                draw::rounded_rect{.bounds = placed(*bar), .radii = draw::uniform(0.0F)},
                draw::solid(marks.caret_tint)
            );
        }
    }
}

auto selection_bands(const text::text_layout& laid_out, text_selection selection)
    -> std::vector<draw::rect> {
    std::vector<draw::rect> bands;
    if (is_collapsed(selection)) {
        return bands;
    }
    const isize begin = selection_begin(selection);
    const isize end = selection_end(selection);
    for (const auto [index, line] : std::views::enumerate(laid_out.lines)) {
        const isize from = std::max(begin, line.text_begin);
        const isize until = std::min(end, line.text_end);
        // A selection running through a line's break covers the line even where it has no text.
        const bool spans_line = begin <= line.text_begin && end > line.text_end;
        if (from >= until && !spans_line) {
            continue;
        }
        const f32 top = static_cast<f32>(index) * laid_out.line_height;
        const f32 left = caret_point(laid_out, from).x;
        const f32 right =
            until >= line.text_end ? line_end_x(laid_out, line) : caret_point(laid_out, until).x;
        bands.push_back({
            .min = {.x = left, .y = top},
            .max = {.x = std::max(right, left + 1.0F), .y = top + laid_out.line_height},
        });
    }
    return bands;
}

auto is_caret_lit(const context& frame, const field_memory& memory) -> bool {
    const std::chrono::milliseconds blink = frame.tokens().motion.caret_blink;
    if (blink.count() == 0) {
        return true;
    }
    const auto since = std::chrono::duration_cast<std::chrono::milliseconds>(
        frame.input().time - memory.caret_moved
    );
    return (since / blink) % 2 == 0;
}

// The text as shown: the composition, while there is one, spliced in at the caret.
struct shown_text {
    std::string utf8;
    text_selection selection;
    // The composition's bytes in utf8; empty without one.
    isize composed_begin = 0;
    isize composed_end = 0;
};

auto shown_of(const edit_buffer& buffer) -> shown_text {
    const composition& composing = buffer.active_composition();
    if (composing.utf8.empty()) {
        return {
            .utf8 = buffer.text(),
            .selection = buffer.selection(),
            .composed_begin = 0,
            .composed_end = 0,
        };
    }
    const isize spliced_at = buffer.selection().caret;
    std::string spliced = buffer.text();
    spliced.insert(narrow<usize>(spliced_at), composing.utf8);
    const isize caret = spliced_at + composing.caret;
    return {
        .utf8 = std::move(spliced),
        .selection = {.anchor = caret, .caret = caret},
        .composed_begin = spliced_at,
        .composed_end = spliced_at + std::ssize(composing.utf8),
    };
}

auto marks_of(
    const context& frame,
    const field_memory& memory,
    const shown_text& shown,
    const text::text_layout& laid_out,
    const interaction& hit
) -> field_marks {
    const theme& tokens = frame.tokens();
    field_marks marks{
        .selection = selection_bands(laid_out, shown.selection),
        .caret = std::nullopt,
        .underline = std::nullopt,
        .selection_tint = tokens.colors.selection,
        .caret_tint = tokens.colors.ink,
    };
    if (hit.is_focused && is_collapsed(shown.selection) && is_caret_lit(frame, memory)) {
        const draw::vec2 top = caret_point(laid_out, shown.selection.caret);
        marks.caret = draw::rect{
            .min = top,
            .max = {.x = top.x + tokens.controls.caret_width, .y = top.y + laid_out.line_height},
        };
    }
    if (shown.composed_end > shown.composed_begin) {
        const draw::vec2 from = caret_point(laid_out, shown.composed_begin);
        const draw::vec2 until = caret_point(laid_out, shown.composed_end);
        const f32 base = from.y + laid_out.line_height - tokens.controls.caret_width;
        marks.underline = draw::rect{
            .min = {.x = from.x, .y = base},
            .max = {.x = std::max(until.x, from.x + 1.0F), .y = base + tokens.controls.caret_width},
        };
    }
    return marks;
}

auto field_style(
    const theme& tokens, const text_field_spec& spec, const interaction& hit, f32 line_height
) -> box_style {
    const bool is_multiple = spec.lines == text_lines::multiple;
    const f32 height =
        is_multiple ? (line_height * static_cast<f32>(std::max(spec.visible_lines, isize{1})))
                          + (2.0F * tokens.spacing.s)
                    : tokens.controls.height;
    return {
        .flow = direction::column,
        .width = grow(),
        .height = fixed(height),
        .padding = symmetric(tokens.spacing.m, is_multiple ? tokens.spacing.s : 0.0F),
        .gap = 0.0F,
        .main = main_align::start,
        .cross = cross_align::start,
        .look =
            {
                .fill = draw::solid(tokens.colors.sunken),
                .radius = tokens.radii.m,
                .outline = hit.is_focused ? tokens.colors.focus : draw::transparent,
                .outline_width = tokens.controls.focus_width,
                .shadow = std::nullopt,
                .glass = std::nullopt,
            },
        .clip = clipping::children,
    };
}

auto inner_of(const draw::rect& area, const box_style& style) -> draw::rect {
    return {
        .min = {.x = area.min.x + style.padding.left, .y = area.min.y + style.padding.top},
        .max = {.x = area.max.x - style.padding.right, .y = area.max.y - style.padding.bottom},
    };
}

}

auto offset_at(const text::text_layout& laid_out, draw::vec2 point) -> isize {
    if (laid_out.lines.empty()) {
        return 0;
    }
    const f32 row = laid_out.line_height > 0.0F ? std::floor(point.y / laid_out.line_height) : 0.0F;
    const isize index =
        std::clamp(static_cast<isize>(row), isize{0}, std::ssize(laid_out.lines) - 1);
    const text::text_line& line = laid_out.lines.at(narrow<usize>(index));
    isize offset = line.text_begin;
    const std::span<const text::placed_glyph> glyphs = glyphs_of(laid_out, line);
    for (const auto [position, glyph] : std::views::enumerate(glyphs)) {
        const f32 middle = glyph_x(glyph, laid_out) + (units(glyph.advance, laid_out) / 2.0F);
        if (point.x < middle) {
            return glyph.text_offset;
        }
        offset = position + 1 < std::ssize(glyphs)
                     ? glyphs.subspan(narrow<usize>(position + 1)).front().text_offset
                     : line.text_end;
    }
    // A line broken by wrapping ends where the next begins: its last offset is the next line's.
    const bool is_wrapped = index + 1 < std::ssize(laid_out.lines)
                            && laid_out.lines.at(narrow<usize>(index + 1)).text_begin == offset;
    return is_wrapped && offset > line.text_begin ? offset - 1 : offset;
}

auto caret_point(const text::text_layout& laid_out, isize offset) -> draw::vec2 {
    if (laid_out.lines.empty()) {
        return {.x = 0.0F, .y = 0.0F};
    }
    const isize index = line_of(laid_out, offset);
    const text::text_line& line = laid_out.lines.at(narrow<usize>(index));
    const f32 top = static_cast<f32>(index) * laid_out.line_height;
    for (const text::placed_glyph& glyph : glyphs_of(laid_out, line)) {
        if (glyph.text_offset >= offset) {
            return {.x = glyph_x(glyph, laid_out), .y = top};
        }
    }
    return {.x = line_end_x(laid_out, line), .y = top};
}

auto text_field(context& frame, local_key key, const text_field_spec& spec) -> text_field_outcome {
    const theme& tokens = frame.tokens();
    const element_id id = frame.id_of(key);
    const interaction hit = frame.interact(id, flags{sense::drag, sense::focus});
    field_memory& memory = frame.field(id, spec.utf8);
    if (memory.buffer.text() != spec.utf8) {
        memory.buffer.reset(std::string{spec.utf8});
    }
    const text_selection selected_before = memory.buffer.selection();
    const std::string composed_before = memory.buffer.active_composition().utf8;
    const box_style probe = field_style(tokens, spec, hit, 0.0F);
    const std::optional<draw::rect> inner =
        hit.rect ? std::optional{inner_of(*hit.rect, probe)} : std::nullopt;
    editing edit{
        .frame = &frame,
        .memory = &memory,
        .spec = &spec,
        .wrap_width = inner ? inner->max.x - inner->min.x : 0.0F,
        .is_submitted = false,
    };
    if (hit.is_focused) {
        take_keyboard(edit);
    }
    if (const text::text_layout* const laid_out = laid_out_now(edit);
        laid_out != nullptr && inner) {
        take_pointer(edit, hit, *inner, *laid_out);
    }
    if (spec.lines == text_lines::multiple && hit.is_hovered && inner) {
        memory.scroll.y -= frame.input().wheel.y * tokens.controls.wheel_step;
    }
    const bool has_moved = memory.buffer.selection() != selected_before
                           || memory.buffer.text() != spec.utf8
                           || memory.buffer.active_composition().utf8 != composed_before;
    if (has_moved) {
        memory.caret_moved = frame.input().time;
    }

    const shown_text shown = shown_of(memory.buffer);
    const bool is_hinted = shown.utf8.empty();
    text_spec visible = text_of(edit, is_hinted ? spec.hint : std::string_view{shown.utf8});
    visible.ink = is_hinted ? tokens.colors.muted_ink : tokens.colors.ink;
    const result<const text::text_layout*> measured =
        frame.measure(text_of(edit, shown.utf8), edit.wrap_width);
    const text::text_layout* const laid_out = measured ? *measured : nullptr;
    const f32 line_height = laid_out != nullptr ? laid_out->line_height : tokens.type.body.size;
    const box_style style = field_style(tokens, spec, hit, line_height);
    if (laid_out != nullptr && inner) {
        const draw::vec2 view{.x = inner->max.x - inner->min.x, .y = inner->max.y - inner->min.y};
        if (has_moved || spec.lines == text_lines::single) {
            reveal_caret(memory, *laid_out, view, tokens);
        } else {
            memory.scroll.y =
                std::clamp(memory.scroll.y, 0.0F, std::max(laid_out->size.y - view.y, 0.0F));
        }
    }
    field_marks marks =
        laid_out != nullptr ? marks_of(frame, memory, shown, *laid_out, hit) : field_marks{};
    const bool is_multiple = spec.lines == text_lines::multiple;
    const box_style content{
        .flow = direction::column,
        .width = is_multiple ? grow() : fit(),
        .height = fit(),
        .gap = 0.0F,
        .main = main_align::start,
        .cross = cross_align::start,
        .pinned = pin{
            .parent_point = {.x = 0.0F, .y = is_multiple ? 0.0F : 0.5F},
            .own_point = {.x = 0.0F, .y = is_multiple ? 0.0F : 0.5F},
            .offset = {.x = -memory.scroll.x, .y = -memory.scroll.y},
        },
    };
    frame.box(key, style, [&] {
        frame.box(ui::key<"content">(), content, [&] {
            frame.custom(
                ui::key<"marks">(),
                {
                    .flow = direction::row,
                    .width = grow(),
                    .height = grow(),
                    .gap = 0.0F,
                    .main = main_align::start,
                    .cross = cross_align::start,
                    .pinned = absolute({.x = 0.0F, .y = 0.0F}),
                },
                [drawn = std::move(marks)](draw::draw_list& list, const draw::rect& area) {
                    draw_marks(list, area, drawn);
                }
            );
            frame.text(ui::key<"text">(), visible);
        });
    });
    std::optional<std::string> edited;
    if (memory.buffer.text() != spec.utf8) {
        edited = memory.buffer.text();
    }
    return {.edited = std::move(edited), .is_submitted = edit.is_submitted, .hit = hit};
}

}
