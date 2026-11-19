#pragma once

#include <array>
#include <cstddef>

#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// One tick's command as client.dll builds it: the CUserCmd in the local controller's ring, its
// base command (CBaseUserCmdPB, a protobuf message), the button state that serializes
// (CInButtonStatePB) and the subtick steps (CSubtickMoveStep). Their finders are in
// targets/cs2/finders/src/command.cpp.
namespace lucent::cs2::foreign {

// Mirrors, never read whole.
struct user_cmd;
struct base_user_cmd;
struct button_state_pb;
struct subtick_step;
struct step_rep;
struct proto_arena;

// protobuf's RepeatedPtrFieldBase, at a repeated field's place in its message: the arena, the
// live count, the capacity, then the rep. The arena is what New takes, the field's own address
// what AddAllocated takes.
// build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44)
// found: CBaseUserCmdPB's parse of field 18 reads the count at field+8 and the rep at
// field+0x10, then calls New with [field] and AddAllocated with the field (base_steps' finder
// checks all three)
// breaks: the finder fails, and the capability with it
struct repeated_ptr_field {
    lucent::foreign::foreign_ptr<proto_arena> arena;
    i32 size = 0;
    i32 capacity = 0;
    lucent::foreign::foreign_ptr<step_rep> rep;
};

static_assert(sizeof(repeated_ptr_field) == 0x18, "protobuf's RepeatedPtrFieldBase");

// The most element slots the command domain reads off a rep: two past the step limit. protobuf
// allocates the rep by capacity, so past it the read sees the neighbouring heap block, which
// nothing past the live count uses; a read that crosses into unmapped memory fails and the tick
// is left as the game built it.
inline constexpr isize step_slots = 32;

// A rep: the elements constructed so far (live and cleared), then their pointers.
// build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44)
// found: the same parse compares the count with [rep] and loads element i from [rep+i*8+8]
// breaks: the step_rep_list finder fails
struct step_list {
    i32 allocated = 0;
    i32 reserved = 0;
    std::array<lucent::foreign::foreign_ptr<subtick_step>, step_slots> elements{};
};

// CInButtonState's and CInButtonStatePB's three words: down now, changed this tick, and the
// edges the game has consumed.
using button_words = std::array<u64, 3>;

// The controller's command ring: its newest sequence, and the command at a sequence (null when
// the ring holds another).
LUCENT_FACT kit::fact::method<i32(player_controller*)> controller_command_sequence{
    "controller_command_sequence",
    client_module,
};
LUCENT_FACT kit::fact::method<user_cmd*(player_controller*, i32)> controller_user_command{
    "controller_user_command",
    client_module,
};

// CUserCmd: its base command, and its own button state, which the client's movement reads.
LUCENT_FACT kit::fact::field<user_cmd, base_user_cmd*> user_cmd_base{
    "user_cmd_base",
    client_module,
};
LUCENT_FACT kit::fact::field<user_cmd, button_words> user_cmd_buttons{
    "user_cmd_buttons",
    client_module,
};

// CBaseUserCmdPB: its has-bits, its button state (field 3), its subtick steps (field 18) and the
// tick's mouse counts (fields 11 and 12). Every message's has-bits word gates its fields: one
// written without its bit set never reaches the wire.
LUCENT_FACT kit::fact::field<base_user_cmd, u32> base_has_bits{"base_has_bits", client_module};
LUCENT_FACT kit::fact::field<base_user_cmd, button_state_pb*> base_buttons{
    "base_buttons",
    client_module,
};
LUCENT_FACT kit::fact::field<base_user_cmd, repeated_ptr_field> base_steps{
    "base_steps",
    client_module,
};
LUCENT_FACT kit::fact::field<base_user_cmd, i32> base_mouse_dx{"base_mouse_dx", client_module};
LUCENT_FACT kit::fact::field<base_user_cmd, i32> base_mouse_dy{"base_mouse_dy", client_module};

// CInButtonStatePB: its has-bits and its three words (fields 1 to 3).
LUCENT_FACT kit::fact::field<button_state_pb, u32> buttons_has_bits{
    "buttons_has_bits",
    client_module,
};
LUCENT_FACT kit::fact::field<button_state_pb, u64> buttons_held{"buttons_held", client_module};
LUCENT_FACT kit::fact::field<button_state_pb, u64> buttons_changed{
    "buttons_changed",
    client_module,
};
LUCENT_FACT kit::fact::field<button_state_pb, u64> buttons_scroll{
    "buttons_scroll",
    client_module,
};

// The steps' rep, read whole.
LUCENT_FACT kit::fact::field<step_rep, step_list> step_rep_list{"step_rep_list", client_module};

// A step made in an arena (CSubtickMoveStep's New), and added to a repeated field the way
// protobuf's Add does once no cleared element is left; it answers the element.
LUCENT_FACT kit::fact::method<subtick_step*(proto_arena*)> subtick_step_new{
    "subtick_step_new",
    client_module,
};
LUCENT_FACT kit::fact::method<subtick_step*(repeated_ptr_field*, subtick_step*)> repeated_add{
    "repeated_add",
    client_module,
};

// CSubtickMoveStep: its has-bits; the button (field 1), pressed (2), when (3), the analog deltas
// (4 and 5) and the view deltas (8 and 9).
LUCENT_FACT kit::fact::field<subtick_step, u32> step_has_bits{"step_has_bits", client_module};
LUCENT_FACT kit::fact::field<subtick_step, u64> step_button{"step_button", client_module};
LUCENT_FACT kit::fact::field<subtick_step, bool> step_pressed{"step_pressed", client_module};
LUCENT_FACT kit::fact::field<subtick_step, f32> step_when{"step_when", client_module};
LUCENT_FACT kit::fact::field<subtick_step, f32> step_forward{"step_forward", client_module};
LUCENT_FACT kit::fact::field<subtick_step, f32> step_left{"step_left", client_module};
LUCENT_FACT kit::fact::field<subtick_step, f32> step_pitch{"step_pitch", client_module};
LUCENT_FACT kit::fact::field<subtick_step, f32> step_yaw{"step_yaw", client_module};

// Reading the local controller's newest command and writing its buttons, steps and mouse counts.
// One capability: the command domain applies all of it once a tick.
using user_command = kit::capability<
    local_player_controller,
    controller_command_sequence,
    controller_user_command,
    user_cmd_base,
    user_cmd_buttons,
    base_has_bits,
    base_buttons,
    base_steps,
    base_mouse_dx,
    base_mouse_dy,
    buttons_has_bits,
    buttons_held,
    buttons_changed,
    buttons_scroll,
    step_rep_list,
    subtick_step_new,
    repeated_add,
    step_has_bits,
    step_button,
    step_pressed,
    step_when,
    step_forward,
    step_left,
    step_pitch,
    step_yaw>;
LUCENT_CAPABILITY kit::capability_record<user_command> user_command_record
    [[gnu::used]]{"user_command", kit::capability_level::optional};

}
