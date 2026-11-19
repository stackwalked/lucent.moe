#include <lucent/ui/input_snapshot.hpp>

#include <algorithm>

namespace lucent::ui {

auto has_key(const input_snapshot& input, key_event event) -> bool {
    return std::ranges::contains(input.keys, event);
}

auto has_press(const input_snapshot& input, key_code code) -> bool {
    return has_key(input, {.code = code, .action = key_action::pressed})
           || has_key(input, {.code = code, .action = key_action::repeated});
}

}
