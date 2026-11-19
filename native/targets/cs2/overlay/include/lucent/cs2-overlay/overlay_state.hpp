#pragma once

#include <optional>

namespace lucent::cs2::overlay {

// A D3D11 device by its address, only ever compared. The overlay's renderer holds a reference to
// the device it was made for, so no new device can reuse the address of the one it knows.
enum class device_id : uptr {};

// How a renderer's build ended, from the renderer's state after it.
enum class build_outcome : u8 {
    ready,
    // Failed; the renderer allows another try.
    retry,
    // Failed for good on this device.
    given_up,
};

// What the glue does with a frame the game's window presents.
enum class frame_action : u8 {
    // Leave the frame alone.
    none,
    // Drop the renderer, make one for this frame's device, and build it.
    start_over,
    // Build the renderer again.
    build,
    // Draw, after handing the renderer every atlas page: it has none of them yet.
    draw_with_atlas,
    draw,
};

// When the overlay draws. It is off until a renderer for the presenting device is built, a new
// device starts it over, and once turned off it stays off for the session.
//
// The glue does what frame() returns, and every start_over or build is answered by landed() once
// that build ends: until then the renderer is the builder's, and nothing is dropped or drawn.
class overlay_state final {
public:
    auto frame(device_id device) -> frame_action;
    auto landed(build_outcome outcome) -> void;
    // A fault, or a build that could not be started.
    auto turn_off() -> void;

private:
    enum class phase : u8 {
        empty,
        building,
        retry,
        given_up,
        ready,
        drawn,
        off,
    };

    phase m_phase = phase::empty;
    std::optional<device_id> m_device;
};

}
