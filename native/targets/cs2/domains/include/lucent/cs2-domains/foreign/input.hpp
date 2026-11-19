#pragma once

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// The client's input object (CCSGOInput), which builds each tick's command and holds the view
// angles the camera draws from, and the two game calls the command and view domains run at:
// CreateMove and FrameStageNotify. Their finders are in targets/cs2/finders/src/input.cpp.
namespace lucent::cs2::foreign {

// Mirrors, never read whole.
struct ccsgo_input;
struct source2_client;
struct input_sample;

// Source's QAngle: pitch, yaw, roll in degrees.
struct angles {
    f32 pitch = 0.0F;
    f32 yaw = 0.0F;
    f32 roll = 0.0F;
};

// client.dll's pointer to its one CCSGOInput.
LUCENT_FACT kit::fact::global<ccsgo_input*> input{"input", client_module};

// CCSGOInput's vtable, and CreateMove in it: (input, split-screen slot). It finishes the newest
// command of the slot's controller, after the builder made it; a write after it is what the
// command's movement and send see.
LUCENT_FACT kit::fact::vtable<ccsgo_input> input_vtable{"input_vtable", client_module};
LUCENT_FACT kit::fact::method<void(ccsgo_input*, i32)> input_create_move{
    "input_create_move",
    client_module,
};
LUCENT_FACT kit::fact::slot<void(ccsgo_input*, i32)> input_create_move_slot{
    "input_create_move_slot",
    client_module,
    "input_vtable",
};

// CSource2Client's vtable, and FrameStageNotify in it: (client, ClientFrameStage_t), each stage
// of each frame, on the game's main thread.
LUCENT_FACT kit::fact::vtable<source2_client> client_vtable{"client_vtable", client_module};
LUCENT_FACT kit::fact::method<void(source2_client*, i32)> frame_stage_notify{
    "frame_stage_notify",
    client_module,
};
LUCENT_FACT kit::fact::slot<void(source2_client*, i32)> frame_stage_notify_slot{
    "frame_stage_notify_slot",
    client_module,
    "client_vtable",
};

// Where the input object keeps the view angles, as its own getter and setter reach them: the
// angles of the last pending input sample while there are any, the resting angles otherwise.
// The setter itself is a leaf without unwind data, which a method fact can't name, so the view
// domain writes the place it would.
LUCENT_FACT kit::fact::field<ccsgo_input, i32> input_sample_count{
    "input_sample_count",
    client_module,
};
LUCENT_FACT kit::fact::field<ccsgo_input, input_sample*> input_samples{
    "input_samples",
    client_module,
};
LUCENT_FACT kit::fact::value<i32> input_sample_size{
    "input_sample_size",
    client_module,
    {.min = 0x40, .max = 0x1000},
};
LUCENT_FACT kit::fact::field<input_sample, angles> input_sample_angles{
    "input_sample_angles",
    client_module,
};
LUCENT_FACT kit::fact::field<ccsgo_input, angles> input_view_angles{
    "input_view_angles",
    client_module,
};

// The game's mouse conversion: (slot, y counts, x counts, scale, pitch out, yaw out, scaled x
// out, scaled y out). The degrees a number of counts turns the view by under the player's
// sensitivity, its y scale, m_yaw and m_pitch (or the fixed pitch the game forces without
// sv_cheats), the scale being the zoom's.
LUCENT_FACT kit::fact::method<f32*(i32, f32, f32, f32, f32*, f32*, i32*, i32*)> mouse_turn{
    "mouse_turn",
    client_module,
};

// Hooking CreateMove on the input object.
using create_move_hook = kit::capability<input_vtable, input_create_move, input_create_move_slot>;
LUCENT_CAPABILITY kit::capability_record<create_move_hook> create_move_hook_record
    [[gnu::used]]{"create_move_hook", kit::capability_level::optional};

// Hooking FrameStageNotify on the client.
using frame_stage_hook =
    kit::capability<client_vtable, frame_stage_notify, frame_stage_notify_slot>;
LUCENT_CAPABILITY kit::capability_record<frame_stage_hook> frame_stage_hook_record
    [[gnu::used]]{"frame_stage_hook", kit::capability_level::optional};

// Reading and setting the view angles, and what a mouse count turns them by.
using view_angles = kit::capability<
    input,
    input_sample_count,
    input_samples,
    input_sample_size,
    input_sample_angles,
    input_view_angles,
    mouse_turn>;
LUCENT_CAPABILITY kit::capability_record<view_angles> view_angles_record
    [[gnu::used]]{"view_angles", kit::capability_level::optional};

}
