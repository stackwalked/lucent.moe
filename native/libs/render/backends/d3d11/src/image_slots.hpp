#pragma once

#include <optional>
#include <vector>

#include <lucent/draw/image_quad.hpp>

namespace lucent::d3d11 {

struct allocated_image {
    draw::image_handle image{};
    isize slot = 0;
};

// Image handles: a slot in the low bits and, above it, a serial from one process-wide counter
// that never restarts. A destroyed handle, or one from another renderer (an earlier device's),
// never matches a live slot again, so it draws nothing rather than someone else's image.
class image_slots final {
public:
    // Slots a handle can name: the low 24 bits; the serial has the 40 above.
    static constexpr isize max_slots = 16'777'216;

    // A free slot under a fresh serial; absent when every slot is taken.
    auto allocate() -> std::optional<allocated_image>;
    // Frees the handle's slot if it is live. A stale handle changes nothing.
    auto release(draw::image_handle image) -> void;
    // The slot a live handle names; absent for a stale one.
    auto slot_of(draw::image_handle image) const -> std::optional<isize>;

private:
    // Each slot's live serial; zero is free, and no handle carries serial zero.
    std::vector<u64> m_serials;
    std::vector<isize> m_free;
};

}
