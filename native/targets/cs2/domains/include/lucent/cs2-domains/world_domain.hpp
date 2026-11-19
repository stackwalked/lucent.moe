#pragma once

#include <optional>

#include <lucent/cs2-domains/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/published.hpp>

namespace lucent::cs2 {

// What one frame read: the players and the camera together, so a box is projected with the matrix
// of the frame its position came from. Either is empty while its capability is unavailable.
struct world_frame {
    std::optional<world> players;
    std::optional<view> camera;
};

// The world domain: builds a world_frame from the game each frame and publishes it to the render
// thread. Features never build or hold one; they get its parts.
//
// Threads: update() on one thread, the same each time (the present hook's, for now; the game's
// frame stage once a hook there exists); read() on any. Competing features: none, it only reads.
class world_domain final {
public:
    explicit world_domain(lucent::foreign::memory_source game);
    world_domain(const world_domain&) = delete ("the render thread reads its published frame");
    auto operator=(const world_domain&)
        -> world_domain& = delete ("the render thread reads its published frame");
    world_domain(world_domain&&) = delete ("the render thread reads its published frame");
    auto operator=(world_domain&&)
        -> world_domain& = delete ("the render thread reads its published frame");
    ~world_domain() = default;

    auto update() -> void;

    // The reading must not outlive the domain, nor be kept past the frame.
    auto read() -> kit::published<world_frame>::reading;

private:
    lucent::foreign::memory_source m_game;
    kit::published<world_frame> m_published;
};

}
