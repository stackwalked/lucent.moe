#pragma once

#include <lucent/menu/table_catalog.hpp>

namespace lucent::cs2::overlay {

// The menu's text in English, from the dev names of what the module wires. Defined in dev builds
// only, and called only from `if constexpr (kit::is_dev_build)`: a release's catalog comes from
// the server, and none of these names reaches its image.
auto add_dev_text(menu::table_catalog& text) -> void;

}
