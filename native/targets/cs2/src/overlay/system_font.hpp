#pragma once

#include <lucent/text/text_system.hpp>

namespace lucent::cs2::overlay {

// Registers the system's message font (what its dialogs are set in) with the text system, read
// through DirectWrite: no font file of ours and no family name in the image, until the server
// delivers the family to use.
auto add_message_font(text::text_system& text) -> result<text::face_id>;

}
