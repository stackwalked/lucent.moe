#pragma once

#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::kit {

// A line of text a drawing feature asks for, centred on anchor across and resting on it: anchor is
// the middle of the line's bottom edge. In the list's units.
struct label {
    std::string text;
    draw::vec2 anchor;
    f32 size = 14.0F;
    draw::color tint = draw::white;

    auto operator==(const label&) const -> bool = default;
};

// What drawing features draw on in one frame: the frame's draw list, its size, and the labels the
// glue sets in text once every feature has drawn. Features never shape text themselves: the text
// system is the glue's, and a label is a value a test can read back.
//
// Borrows the list for the frame; the render thread's alone.
class canvas final {
public:
    canvas(draw::draw_list& list, draw::vec2 viewport)
        : m_list{&list}
        , m_viewport{viewport} {}

    auto list() const -> draw::draw_list& {
        return *m_list;
    }

    // In the list's units.
    auto viewport() const -> draw::vec2 {
        return m_viewport;
    }

    auto add(label line) -> void {
        m_labels.push_back(std::move(line));
    }

    // In the order they were added.
    auto labels() const -> std::span<const label> {
        return m_labels;
    }

private:
    draw::draw_list* m_list;
    draw::vec2 m_viewport;
    std::vector<label> m_labels;
};

}
