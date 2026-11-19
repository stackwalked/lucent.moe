#include <lucent/cs2-domains/world_domain.hpp>

#include <tuple>
#include <utility>

#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/cs2-domains/foreign/view.hpp>
#include <lucent/cs2-domains/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::cs2 {

world_domain::world_domain(lucent::foreign::memory_source game)
    : m_game{game}
    , m_published{world_frame{}} {}

auto world_domain::update() -> void {
    world_frame next;
    if (kit::is_available(foreign::entities{})) {
        next.players = read_world(kit::read_access<foreign::entities>{m_game});
    }
    if (kit::is_available(foreign::view{})) {
        next.camera = read_view(kit::read_access<foreign::view>{m_game});
    }
    // Refused only while the render thread still reads every other slot: that frame is dropped,
    // and the next one is read fresh.
    std::ignore = m_published.publish(std::move(next));
}

auto world_domain::read() -> kit::published<world_frame>::reading {
    return m_published.read();
}

}
