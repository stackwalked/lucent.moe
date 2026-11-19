#pragma once

#include <optional>

#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/cs2-domains/view_state.hpp>
#include <lucent/cs2-domains/view_turns.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::cs2 {

// The view domain: the mouse model over the game's view. Features ask for turns at createmove
// (view_turns, or the aim_view stage); at the next frame stage the view turns by as many whole
// counts of what was asked as the next command has room for, through the place the game's own
// setter writes; the command domain settles those counts into the next command.
//
// Competing features: their requests add up, with no precedence; the pitch stops at the game's
// limit.
//
// Threads: the game's main thread only (createmove and the frame stage both run there).
class view_domain final {
public:
    view_domain(const kit::domain_token& opens, lucent::foreign::memory_source game);
    view_domain(const view_domain&) = delete ("its turn tokens point into it");
    auto operator=(const view_domain&) -> view_domain& = delete ("its turn tokens point into it");
    view_domain(view_domain&&) = delete ("its turn tokens point into it");
    auto operator=(view_domain&&) -> view_domain& = delete ("its turn tokens point into it");
    ~view_domain() = default;

    // At createmove: the view as it is and the turn requests, when the view can be read.
    auto put_parts(kit::view_set& parts, i64 tick) -> void;

    // At a frame stage: turns the view by what fits of what was asked.
    auto apply() -> void;

    // What the aim_view stage and view_turns record into.
    auto model() -> mouse_model&;

private:
    lucent::foreign::memory_source m_game;
    kit::domain_token m_opens;
    mouse_model m_model;
    std::optional<view_state> m_state;
    std::optional<view_turns> m_turns;
};

}
