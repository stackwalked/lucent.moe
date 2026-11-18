#include "image_slots.hpp"

#include <atomic>
#include <iterator>
#include <optional>
#include <utility>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/image_quad.hpp>

namespace lucent::d3d11 {
namespace {

constexpr u32 slot_bits = 24;
constexpr u64 slot_mask = (u64{1} << slot_bits) - 1;

// The process-wide serial counter: owned by image_slots, the only code that reads or advances it.
// Serials are shared by every renderer the process makes, so a handle outlives its device without
// ever matching an image of the next one.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the counter above.
std::atomic<u64> next_serial{1};

auto fresh_serial() -> u64 {
    // relaxed: a serial only has to be unique, and fetch_add is atomic in any order.
    return next_serial.fetch_add(1, std::memory_order_relaxed);
}

auto serial_of(draw::image_handle image) -> u64 {
    return std::to_underlying(image) >> slot_bits;
}

}

auto image_slots::allocate() -> std::optional<allocated_image> {
    isize slot = 0;
    if (!m_free.empty()) {
        slot = m_free.back();
        m_free.pop_back();
    } else {
        if (std::ssize(m_serials) >= max_slots) {
            return std::nullopt;
        }
        slot = std::ssize(m_serials);
        m_serials.push_back(0);
    }
    // 40 bits of serial: a new image every microsecond for twelve days before one wraps.
    const u64 serial = fresh_serial() & (~u64{0} >> slot_bits);
    m_serials.at(narrow<usize>(slot)) = serial;
    return allocated_image{
        .image = static_cast<draw::image_handle>((serial << slot_bits) | narrow<u64>(slot)),
        .slot = slot,
    };
}

auto image_slots::release(draw::image_handle image) -> void {
    const std::optional<isize> slot = slot_of(image);
    if (!slot) {
        return;
    }
    m_serials.at(narrow<usize>(*slot)) = 0;
    m_free.push_back(*slot);
}

auto image_slots::slot_of(draw::image_handle image) const -> std::optional<isize> {
    const auto slot = narrow<isize>(std::to_underlying(image) & slot_mask);
    const u64 serial = serial_of(image);
    if (serial == 0
        || slot >= std::ssize(m_serials)
        || m_serials.at(narrow<usize>(slot)) != serial) {
        return std::nullopt;
    }
    return slot;
}

}
