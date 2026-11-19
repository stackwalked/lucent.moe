#pragma once

#include <lucent/draw/draw_list.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

namespace lucent::cs2::overlay {

// What dev builds draw until the UI lands: a line of shaped text on a plate, and a shape or two.
// Defined in dev builds only, and called only from `if constexpr (kit::is_dev_build)`, so no
// string of it reaches a release image.
class dev_demo final {
public:
    // Registers a system face through DirectWrite with the text system: no font file of ours.
    static auto create(text::text_system& text) -> result<dev_demo>;

    auto draw(text::text_system& text, draw::draw_list& list) const -> result<void>;

private:
    explicit dev_demo(text::face_id face);

    text::face_id m_face;
};

}
