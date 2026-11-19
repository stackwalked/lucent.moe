#pragma once

#include <chrono>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/draw/vec2.hpp>
#include <lucent/ui/input_snapshot.hpp>

namespace lucent::ui {

// Bytes of the text, both on code point boundaries. The caret is where typing goes; the selection
// runs between it and the anchor.
struct text_selection {
    isize anchor = 0;
    isize caret = 0;

    auto operator==(const text_selection&) const -> bool = default;
};

constexpr auto selection_begin(text_selection selection) -> isize {
    return selection.anchor < selection.caret ? selection.anchor : selection.caret;
}

constexpr auto selection_end(text_selection selection) -> isize {
    return selection.anchor < selection.caret ? selection.caret : selection.anchor;
}

constexpr auto is_collapsed(text_selection selection) -> bool {
    return selection.anchor == selection.caret;
}

// How far one caret step goes.
enum class caret_step : u8 {
    character,
    // To the next start of a word: letters, digits and anything outside ASCII.
    word,
};

enum class selection_mode : u8 {
    // The selection collapses where the caret lands.
    move,
    // The anchor stays.
    extend,
};

// A text being edited: the text, its selection, the undo history and the input method's
// composition. Every offset it hands out sits on a code point boundary of the text.
class edit_buffer final {
public:
    // At most this many undo steps are kept; the oldest go first.
    static constexpr isize history_limit = 100;

    // The caret at the end.
    explicit edit_buffer(std::string utf8);

    auto text() const -> const std::string&;
    auto selection() const -> text_selection;
    auto selected() const -> std::string_view;
    auto active_composition() const -> const composition&;

    // The text changed under the buffer: the history goes, and the caret moves to the end.
    auto reset(std::string utf8) -> void;

    // Replaces the selection. Typing in a row undoes as one step.
    auto insert(std::string_view utf8) -> void;
    // Replaces the selection as a step of its own.
    auto paste(std::string_view utf8) -> void;
    // The selection, or else one step back from the caret.
    auto erase_backward(caret_step step) -> void;
    // The selection, or else one step on from the caret.
    auto erase_forward(caret_step step) -> void;
    // direction is -1 or 1. Moving without extending out of a selection lands on its edge.
    auto move_caret(isize direction, caret_step step, selection_mode mode) -> void;
    // To offset, clamped and snapped back to a code point boundary.
    auto move_to(isize offset, selection_mode mode) -> void;
    auto select_all() -> void;
    // The word at offset, or the run of other characters there.
    auto select_word_at(isize offset) -> void;
    auto compose(const composition& update) -> void;

    auto undo() -> void;
    auto redo() -> void;

private:
    struct saved {
        std::string text;
        text_selection selection;
    };

    enum class edit_kind : u8 {
        none,
        typing,
        erasing,
    };

    auto remember(edit_kind kind) -> void;
    auto replace_selection(std::string_view utf8) -> void;

    std::string m_text;
    text_selection m_selection;
    composition m_composition;
    std::vector<saved> m_undo;
    std::vector<saved> m_redo;
    // What the last edit was, so a run of the same kind undoes as one step.
    edit_kind m_last = edit_kind::none;
    // The last character typed was no part of a word.
    bool m_is_after_gap = false;
};

// The code point boundary at or before offset.
auto boundary_before(std::string_view utf8, isize offset) -> isize;
// The next boundary in direction (-1 or 1) from offset, by step.
auto stepped(std::string_view utf8, isize offset, isize direction, caret_step step) -> isize;

// A text field's state between frames.
struct field_memory {
    edit_buffer buffer;
    // How far the text is scrolled under the field, in units.
    draw::vec2 scroll;
    // The caret shows steadily for a while after it moves, then blinks.
    std::chrono::steady_clock::time_point caret_moved;
    // The click count of the press now held: a drag after a double click keeps the word selected.
    i32 press_clicks = 0;
};

}
