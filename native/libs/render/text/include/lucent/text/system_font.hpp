#pragma once

#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

namespace lucent::text {

// Registers the system's message font (what its dialogs are set in) with the text system, read
// through DirectWrite: no font file of ours and no family name in the image, until the server
// delivers the family to use.
auto add_message_font(text_system& text) -> result<face_id>;

}
