#pragma once

#include <lucent/kit/canvas.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::kit {

// What a feature's draw sees on the render thread: the snapshot parts it declared, its settings as
// of the last safe point, and the canvas. It holds no stage and no foreign access: what a drawing
// feature can change is what it draws. Borrowed for one frame.
//
// Only a class constrains F, as for context.
template <class_type F>
class draw_context final {
public:
    using settings_type = F::settings;

    // The registry builds one only once every needed part is in parts; a test does the same.
    draw_context(const view_set& parts, const settings_type& current, canvas& onto)
        : m_parts{&parts}
        , m_settings{&current}
        , m_canvas{&onto} {}

    template <needed_by<F> Part>
    auto view() const -> const Part& {
        const Part* const found = m_parts->find<Part>();
        LUCENT_INVARIANT(found != nullptr);
        return *found;
    }

    // Null when the domain couldn't build it this frame.
    template <wanted_by<F> Part>
    auto maybe() const -> const Part* {
        return m_parts->find<Part>();
    }

    auto settings() const -> const settings_type& {
        return *m_settings;
    }

    auto onto() const -> canvas& {
        return *m_canvas;
    }

private:
    const view_set* m_parts;
    const settings_type* m_settings;
    canvas* m_canvas;
};

}
