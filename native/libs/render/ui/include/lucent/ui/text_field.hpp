#pragma once

#include <optional>
#include <string>
#include <string_view>

#include <lucent/text/text_layout.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>

namespace lucent::ui {

enum class text_lines : u8 {
    // Enter submits; the text scrolls sideways to keep the caret in view.
    single,
    // Enter breaks the line; the text wraps at the field's width and scrolls down.
    multiple,
};

struct text_field_spec {
    // The text as its owner holds it. A change from outside resets the field's undo history.
    std::string_view utf8;
    // Shown, muted, while the text is empty.
    std::string_view hint;
    text_lines lines = text_lines::single;
    // A multi-line field's height, in lines.
    isize visible_lines = 4;
};

struct text_field_outcome {
    // The text after this frame's editing, on a frame it changes.
    std::optional<std::string> edited;
    // Enter, in a single-line field that has focus.
    bool is_submitted = false;
    interaction hit;
};

// An editable text. While focused it takes typing and the input method's composition, in order;
// Left and Right move by characters, with Control by words, and Shift extends the selection;
// Home and End go to the line's ends; Backspace and Delete erase; Control with A selects all, with
// C, X and V copies, cuts and pastes through the frame's clipboard, and with Z and Y (or Shift Z)
// undoes and redoes. A press places the caret, a drag selects, a double click selects a word, a
// triple click everything.
auto text_field(context& frame, local_key key, const text_field_spec& spec) -> text_field_outcome;

// The byte of laid_out's text nearest point, which is in units from the layout's top left: on
// the line point is beside, before or after the glyph point is over by which half it lands in.
auto offset_at(const text::text_layout& laid_out, draw::vec2 point) -> isize;

// Where a caret before the byte at offset stands, from the layout's top left, in units: x on the
// line, y the line's top.
auto caret_point(const text::text_layout& laid_out, isize offset) -> draw::vec2;

}
