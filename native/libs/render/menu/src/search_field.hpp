#pragma once

#include <string>
#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::menu::detail {

struct search_field_spec {
    std::string_view query;
    // Shown, muted, while the query is empty.
    std::string_view hint;
};

// A stand-in until ui has text fields: a focusable field that, while focused, takes typed text and
// Backspace, with no caret, selection or clipboard. The query after this frame's typing.
auto search_field(ui::context& frame, ui::local_key key, const search_field_spec& spec)
    -> std::string;

// query after the frame's Backspaces, then its typed text without control characters. The snapshot
// doesn't order text against keys, so a character typed and erased in one frame stays.
auto edited(std::string_view query, const ui::input_snapshot& input) -> std::string;

}
