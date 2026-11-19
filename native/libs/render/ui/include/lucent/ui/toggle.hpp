#pragma once

#include <optional>
#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

struct toggle_spec {
    std::string_view caption;
    bool is_on = false;
};

// A row with the caption at its start and a switch at its end; the whole row flips it. The new
// state on the frame it flips.
auto toggle(context& frame, local_key key, const toggle_spec& spec) -> std::optional<bool>;

}
