#include <lucent/cs2-domains/command_stages.hpp>

#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_board.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>

namespace lucent::cs2 {
namespace {

auto pressed(button which, f32 when) -> step_request {
    return button_step{.which = which, .change = edge::press, .when = when};
}

auto released(button which, f32 when) -> step_request {
    return button_step{.which = which, .change = edge::release, .when = when};
}

}

auto movement_stage::press(button which, f32 when) const -> void {
    m_board->add(stage::movement, pressed(which, when));
}

auto movement_stage::release(button which, f32 when) const -> void {
    m_board->add(stage::movement, released(which, when));
}

auto movement_stage::move(analog_step moved) const -> void {
    m_board->add(stage::movement, moved);
}

auto aim_view_stage::turn(view_turn wanted) const -> void {
    m_view->request(wanted);
}

auto aim_shot_stage::press(button which, f32 when) const -> void {
    m_board->add(stage::aim_shot, pressed(which, when));
}

auto aim_shot_stage::release(button which, f32 when) const -> void {
    m_board->add(stage::aim_shot, released(which, when));
}

auto trigger_stage::press(button which, f32 when) const -> void {
    m_board->add(stage::trigger, pressed(which, when));
}

auto trigger_stage::release(button which, f32 when) const -> void {
    m_board->add(stage::trigger, released(which, when));
}

auto script_stage::press(button which, f32 when) const -> void {
    m_board->add(stage::scripts, pressed(which, when));
}

auto script_stage::release(button which, f32 when) const -> void {
    m_board->add(stage::scripts, released(which, when));
}

}
