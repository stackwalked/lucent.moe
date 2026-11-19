#pragma once

#include <lucent/cs2-domains/foreign/input.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>

namespace lucent::cs2 {

// Asks the view to turn; every feature's requests this tick add up. Borrowed for the tick it was
// handed in, on the game thread.
class view_turns final {
public:
    using backing = foreign::view_angles;

    explicit view_turns(mouse_model& view)
        : m_view{&view} {}

    auto turn(view_turn wanted) const -> void;

private:
    mouse_model* m_view;
};

}
