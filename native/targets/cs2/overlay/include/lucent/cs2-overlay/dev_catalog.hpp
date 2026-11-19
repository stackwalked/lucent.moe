#pragma once

#include <lucent/menu/table_catalog.hpp>

namespace lucent::cs2::overlay {

// The menu's text in English, from the dev names of what the module wires. The module calls it
// only from `if constexpr (kit::is_dev_build)`, so a release image never links it: a release's
// catalog comes from the server, and none of these names reaches its image.
auto add_dev_text(menu::table_catalog& text) -> void;

}
