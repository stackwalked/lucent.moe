#include <lucent/ui/edit_buffer.hpp>

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>

#include <lucent/core/narrow.hpp>
#include <lucent/ui/input_snapshot.hpp>

namespace lucent::ui {
namespace {

auto is_continuation(char unit) -> bool {
    return (static_cast<u8>(unit) & 0xc0U) == 0x80U;
}

auto unit_at(std::string_view utf8, isize offset) -> char {
    return utf8.at(narrow<usize>(offset));
}

// ASCII letters and digits, and every byte of a code point outside ASCII: a word is a run of them.
auto is_word_unit(char unit) -> bool {
    const auto byte = static_cast<u8>(unit);
    return byte >= 0x80U
           || (byte >= '0' && byte <= '9')
           || (byte >= 'a' && byte <= 'z')
           || (byte >= 'A' && byte <= 'Z')
           || byte == '_';
}

auto next_character(std::string_view utf8, isize offset) -> isize {
    const isize size = std::ssize(utf8);
    if (offset >= size) {
        return size;
    }
    ++offset;
    while (offset < size && is_continuation(unit_at(utf8, offset))) {
        ++offset;
    }
    return offset;
}

auto previous_character(std::string_view utf8, isize offset) -> isize {
    if (offset <= 0) {
        return 0;
    }
    --offset;
    while (offset > 0 && is_continuation(unit_at(utf8, offset))) {
        --offset;
    }
    return offset;
}

// Past this word and the gap after it: where Ctrl+Right lands.
auto next_word(std::string_view utf8, isize offset) -> isize {
    const isize size = std::ssize(utf8);
    while (offset < size && is_word_unit(unit_at(utf8, offset))) {
        ++offset;
    }
    while (offset < size && !is_word_unit(unit_at(utf8, offset))) {
        ++offset;
    }
    return boundary_before(utf8, offset);
}

// Back over the gap before the caret, then to the start of the word before it.
auto previous_word(std::string_view utf8, isize offset) -> isize {
    while (offset > 0 && !is_word_unit(unit_at(utf8, offset - 1))) {
        --offset;
    }
    while (offset > 0 && is_word_unit(unit_at(utf8, offset - 1))) {
        --offset;
    }
    return boundary_before(utf8, offset);
}

}

auto boundary_before(std::string_view utf8, isize offset) -> isize {
    offset = std::clamp(offset, isize{0}, std::ssize(utf8));
    while (offset > 0 && offset < std::ssize(utf8) && is_continuation(unit_at(utf8, offset))) {
        --offset;
    }
    return offset;
}

auto stepped(std::string_view utf8, isize offset, isize direction, caret_step step) -> isize {
    LUCENT_INVARIANT(direction == -1 || direction == 1);
    switch (step) {
    case caret_step::character:
        return direction > 0 ? next_character(utf8, offset) : previous_character(utf8, offset);
    case caret_step::word:
        return direction > 0 ? next_word(utf8, offset) : previous_word(utf8, offset);
    }
    LUCENT_UNREACHABLE();
}

edit_buffer::edit_buffer(std::string utf8)
    : m_text{std::move(utf8)}
    , m_selection{.anchor = std::ssize(m_text), .caret = std::ssize(m_text)} {}

auto edit_buffer::text() const -> const std::string& {
    return m_text;
}

auto edit_buffer::selection() const -> text_selection {
    return m_selection;
}

auto edit_buffer::selected() const -> std::string_view {
    const isize begin = selection_begin(m_selection);
    return std::string_view{m_text}.substr(
        narrow<usize>(begin), narrow<usize>(selection_end(m_selection) - begin)
    );
}

auto edit_buffer::active_composition() const -> const composition& {
    return m_composition;
}

auto edit_buffer::reset(std::string utf8) -> void {
    m_text = std::move(utf8);
    m_selection = {.anchor = std::ssize(m_text), .caret = std::ssize(m_text)};
    m_composition = {};
    m_undo.clear();
    m_redo.clear();
    m_last = edit_kind::none;
}

auto edit_buffer::insert(std::string_view utf8) -> void {
    if (utf8.empty() && is_collapsed(m_selection)) {
        return;
    }
    // A selection replaced is a step of its own, as is each word typed after a gap: typing undoes
    // by words, each with the gap after it.
    const bool is_word_start = !utf8.empty() && is_word_unit(utf8.front()) && m_is_after_gap;
    remember(is_collapsed(m_selection) && !is_word_start ? edit_kind::typing : edit_kind::none);
    if (!utf8.empty()) {
        m_is_after_gap = !is_word_unit(utf8.back());
    }
    replace_selection(utf8);
    m_last = edit_kind::typing;
}

auto edit_buffer::paste(std::string_view utf8) -> void {
    if (utf8.empty() && is_collapsed(m_selection)) {
        return;
    }
    remember(edit_kind::none);
    replace_selection(utf8);
}

auto edit_buffer::erase_backward(caret_step step) -> void {
    if (is_collapsed(m_selection)) {
        if (m_selection.caret == 0) {
            return;
        }
        m_selection.anchor = stepped(m_text, m_selection.caret, -1, step);
    }
    remember(edit_kind::erasing);
    replace_selection({});
}

auto edit_buffer::erase_forward(caret_step step) -> void {
    if (is_collapsed(m_selection)) {
        if (m_selection.caret == std::ssize(m_text)) {
            return;
        }
        m_selection.anchor = stepped(m_text, m_selection.caret, 1, step);
    }
    remember(edit_kind::erasing);
    replace_selection({});
}

auto edit_buffer::move_caret(isize direction, caret_step step, selection_mode mode) -> void {
    m_last = edit_kind::none;
    if (mode == selection_mode::move && !is_collapsed(m_selection)) {
        const isize edge =
            direction > 0 ? selection_end(m_selection) : selection_begin(m_selection);
        m_selection = {.anchor = edge, .caret = edge};
        return;
    }
    move_to(stepped(m_text, m_selection.caret, direction, step), mode);
}

auto edit_buffer::move_to(isize offset, selection_mode mode) -> void {
    m_last = edit_kind::none;
    m_selection.caret = boundary_before(m_text, offset);
    if (mode == selection_mode::move) {
        m_selection.anchor = m_selection.caret;
    }
}

auto edit_buffer::select_all() -> void {
    m_last = edit_kind::none;
    m_selection = {.anchor = 0, .caret = std::ssize(m_text)};
}

auto edit_buffer::select_word_at(isize offset) -> void {
    m_last = edit_kind::none;
    offset = boundary_before(m_text, offset);
    if (m_text.empty()) {
        m_selection = {};
        return;
    }
    // The character the offset is before, or the last one at the end.
    const isize probe = offset < std::ssize(m_text) ? offset : previous_character(m_text, offset);
    const bool is_word = is_word_unit(unit_at(m_text, probe));
    isize begin = probe;
    isize end = probe;
    while (begin > 0 && is_word_unit(unit_at(m_text, begin - 1)) == is_word) {
        --begin;
    }
    while (end < std::ssize(m_text) && is_word_unit(unit_at(m_text, end)) == is_word) {
        ++end;
    }
    m_selection = {.anchor = boundary_before(m_text, begin), .caret = boundary_before(m_text, end)};
}

auto edit_buffer::compose(const composition& update) -> void {
    m_composition = update;
    m_composition.caret = boundary_before(m_composition.utf8, update.caret);
}

auto edit_buffer::undo() -> void {
    if (m_undo.empty()) {
        return;
    }
    m_redo.push_back({.text = m_text, .selection = m_selection});
    m_text = std::move(m_undo.back().text);
    m_selection = m_undo.back().selection;
    m_undo.pop_back();
    m_last = edit_kind::none;
}

auto edit_buffer::redo() -> void {
    if (m_redo.empty()) {
        return;
    }
    m_undo.push_back({.text = m_text, .selection = m_selection});
    m_text = std::move(m_redo.back().text);
    m_selection = m_redo.back().selection;
    m_redo.pop_back();
    m_last = edit_kind::none;
}

auto edit_buffer::remember(edit_kind kind) -> void {
    m_redo.clear();
    const bool is_continued = kind != edit_kind::none && kind == m_last;
    m_last = kind;
    if (is_continued) {
        return;
    }
    if (std::ssize(m_undo) >= history_limit) {
        m_undo.erase(m_undo.begin());
    }
    m_undo.push_back({.text = m_text, .selection = m_selection});
}

auto edit_buffer::replace_selection(std::string_view utf8) -> void {
    const isize begin = selection_begin(m_selection);
    const isize end = selection_end(m_selection);
    m_text.replace(narrow<usize>(begin), narrow<usize>(end - begin), utf8);
    const isize caret = begin + std::ssize(utf8);
    m_selection = {.anchor = caret, .caret = caret};
}

}
