#include <lucent/cs2-overlay/overlay_state.hpp>

namespace lucent::cs2::overlay {

auto overlay_state::frame(device_id device) -> frame_action {
    // A building renderer is the builder's: even a new device waits for it to land.
    if (m_phase == phase::off || m_phase == phase::building) {
        return frame_action::none;
    }
    if (m_phase == phase::empty || m_device != device) {
        m_device = device;
        m_phase = phase::building;
        return frame_action::start_over;
    }
    switch (m_phase) {
    case phase::retry:
        m_phase = phase::building;
        return frame_action::build;
    case phase::ready:
        m_phase = phase::drawn;
        return frame_action::draw_with_atlas;
    case phase::drawn:
        return frame_action::draw;
    case phase::given_up:
        return frame_action::none;
    case phase::empty:
    case phase::building:
    case phase::off:
        LUCENT_UNREACHABLE();
    }
    LUCENT_UNREACHABLE();
}

auto overlay_state::landed(build_outcome outcome) -> void {
    // A build started before the overlay was turned off still ends; it changes nothing.
    if (m_phase == phase::off) {
        return;
    }
    LUCENT_INVARIANT(m_phase == phase::building);
    switch (outcome) {
    case build_outcome::ready:
        m_phase = phase::ready;
        return;
    case build_outcome::retry:
        m_phase = phase::retry;
        return;
    case build_outcome::given_up:
        m_phase = phase::given_up;
        return;
    }
}

auto overlay_state::turn_off() -> void {
    m_phase = phase::off;
}

}
