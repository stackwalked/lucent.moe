#include "build_attempts.hpp"

#include <lucent/d3d11/renderer.hpp>

namespace lucent::d3d11 {

auto build_attempts::state() const -> renderer_state {
    return m_state;
}

auto build_attempts::can_start() const -> bool {
    return m_state == renderer_state::idle;
}

auto build_attempts::start() -> void {
    LUCENT_INVARIANT(can_start());
    m_state = renderer_state::building;
}

auto build_attempts::succeed() -> void {
    LUCENT_INVARIANT(m_state == renderer_state::building);
    m_state = renderer_state::ready;
}

auto build_attempts::fail() -> void {
    LUCENT_INVARIANT(m_state == renderer_state::building);
    m_failures += 1;
    m_state = m_failures >= max_failures ? renderer_state::failed : renderer_state::idle;
}

}
