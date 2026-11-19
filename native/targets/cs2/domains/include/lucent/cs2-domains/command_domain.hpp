#pragma once

#include <optional>
#include <vector>

#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_board.hpp>
#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/command_stages.hpp>
#include <lucent/cs2-domains/foreign/user_cmd.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::cs2 {

// The command domain: each tick, at createmove, reads the local player's newest command, hands
// features the command as the game built it and the stage tokens, and applies what the stages
// asked for once, under plan_command's conflict rule, with the mouse counts the view owes.
//
// Threads: the game's main thread only, where createmove runs. Order per tick: world, then
// movement (once it exists), then command apply.
class command_domain final {
public:
    command_domain(const kit::domain_token& opens, lucent::foreign::memory_source game);
    command_domain(const command_domain&) = delete ("its stage tokens point into it");
    auto operator=(const command_domain&) -> command_domain& = delete ("its tokens point into it");
    command_domain(command_domain&&) = delete ("its stage tokens point into it");
    auto operator=(command_domain&&) -> command_domain& = delete ("its tokens point into it");
    ~command_domain() = default;

    // Reads this tick's command; puts nothing when there is none (no local controller, no
    // command in its ring) or its capability is unavailable.
    auto open() -> void;

    // The command and the stage tokens, while a command is open. aim_view goes to view.
    auto put_parts(kit::view_set& parts, mouse_model& view) -> void;

    // Writes the stages' requests and the counts into the open command and closes it. Answers
    // whether the counts went in: until they do, the view keeps owing them.
    auto apply(mouse_counts owed) -> bool;

    // The commands opened so far: the domain clock's tick.
    auto tick() const -> i64;

private:
    lucent::foreign::memory_source m_game;
    kit::domain_token m_opens;
    i64 m_tick = 0;
    std::optional<command_input> m_input;
    std::vector<step_refusal> m_refusals;
    command_board m_board;
    std::optional<movement_stage> m_movement;
    std::optional<aim_view_stage> m_aim_view;
    std::optional<aim_shot_stage> m_aim_shot;
    std::optional<trigger_stage> m_trigger;
    std::optional<script_stage> m_scripts;
};

}
