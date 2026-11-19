#include <lucent/ui/input_snapshot.hpp>

#include <algorithm>
#include <vector>

#include <lucent/core/match.hpp>

namespace lucent::ui {

auto has_key(const input_snapshot& input, key_event event) -> bool {
    return std::ranges::contains(input.keyboard, keyboard_event{event});
}

auto has_press(const input_snapshot& input, key_code code) -> bool {
    return has_key(input, {.code = code, .action = key_action::pressed})
           || has_key(input, {.code = code, .action = key_action::repeated});
}

auto keys_of(const input_snapshot& input) -> std::vector<key_event> {
    std::vector<key_event> keys;
    for (const keyboard_event& event : input.keyboard) {
        match(
            event,
            [&keys](const key_event& key) { keys.push_back(key); },
            [](const typed_text&) {},
            [](const composition&) {}
        );
    }
    return keys;
}

}
