#pragma once

#include <lucent/d3d11/renderer.hpp>

namespace lucent::d3d11 {

// A renderer's builds on one device: idle until one starts, ready once one succeeds, and failed
// after the third failure, until a new device brings a new renderer.
class build_attempts final {
public:
    static constexpr isize max_failures = 3;

    auto state() const -> renderer_state;

    // Whether a build may start now: from idle only.
    auto can_start() const -> bool;
    auto start() -> void;
    auto succeed() -> void;
    auto fail() -> void;

private:
    renderer_state m_state = renderer_state::idle;
    isize m_failures = 0;
};

}
