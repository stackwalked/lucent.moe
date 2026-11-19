#pragma once

#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_board.hpp>
#include <lucent/cs2-domains/foreign/input.hpp>
#include <lucent/cs2-domains/foreign/user_cmd.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>

// createmove's stage tokens: what each stage may write, one owner each (but scripts), borrowed for
// the tick they were handed in on the game thread. A feature names the stage it owns among its
// needs; the wiring refuses a second owner.
namespace lucent::cs2 {

// The movement stage: buttons and the analog axes. The movement domain will own it, and emit
// with it.
class movement_stage final {
public:
    using backing = foreign::user_command;
    static constexpr bool is_exclusive = true;

    explicit movement_stage(command_board& board)
        : m_board{&board} {}

    auto press(button which, f32 when) const -> void;
    auto release(button which, f32 when) const -> void;
    auto move(analog_step moved) const -> void;

private:
    command_board* m_board;
};

// The aim's view stage: heading only, which goes to the view domain as a request; it never writes
// the command's angles.
class aim_view_stage final {
public:
    using backing = foreign::view_angles;
    static constexpr bool is_exclusive = true;

    explicit aim_view_stage(mouse_model& view)
        : m_view{&view} {}

    auto turn(view_turn wanted) const -> void;

private:
    mouse_model* m_view;
};

// The aim's shot stage: buttons.
class aim_shot_stage final {
public:
    using backing = foreign::user_command;
    static constexpr bool is_exclusive = true;

    explicit aim_shot_stage(command_board& board)
        : m_board{&board} {}

    auto press(button which, f32 when) const -> void;
    auto release(button which, f32 when) const -> void;

private:
    command_board* m_board;
};

// The trigger stage: buttons.
class trigger_stage final {
public:
    using backing = foreign::user_command;
    static constexpr bool is_exclusive = true;

    explicit trigger_stage(command_board& board)
        : m_board{&board} {}

    auto press(button which, f32 when) const -> void;
    auto release(button which, f32 when) const -> void;

private:
    command_board* m_board;
};

// The scripts' stage: buttons, for every script that wants it, in load order.
class script_stage final {
public:
    using backing = foreign::user_command;

    explicit script_stage(command_board& board)
        : m_board{&board} {}

    auto press(button which, f32 when) const -> void;
    auto release(button which, f32 when) const -> void;

private:
    command_board* m_board;
};

}
