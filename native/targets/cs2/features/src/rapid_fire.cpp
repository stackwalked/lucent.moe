#include <lucent/cs2-features/rapid_fire.hpp>

#include <algorithm>
#include <utility>

#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/command_stages.hpp>
#include <lucent/kit/context.hpp>

namespace lucent::cs2::features {
namespace {

constexpr u64 attack = std::to_underlying(button::attack);

// The player's own attack this tick: down by the word the game built, or pressed by a step of it.
auto is_holding_attack(const game_command& game) -> bool {
    const bool is_pressed_in_tick = std::ranges::any_of(game.steps, [](const subtick_step& step) {
        return step.buttons.value_or(0) == attack && step.is_pressed.value_or(false);
    });
    return (game.buttons.held & attack) != 0 || is_pressed_in_tick;
}

}

auto rapid_fire::tick(const kit::context<rapid_fire>& parts) -> void {
    const auto& input = parts.view<command_input>();
    const auto& shot = parts.view<aim_shot_stage>();
    if (!is_holding_attack(input.game)) {
        return;
    }
    if (m_pressed_at == input.tick - 1) {
        shot.release(button::attack, 0.0F);
        return;
    }
    shot.press(button::attack, 0.0F);
    m_pressed_at = input.tick;
}

}
