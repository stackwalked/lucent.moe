#pragma once

#include <vector>

#include <lucent/cs2-domains/command_domain.hpp>
#include <lucent/cs2-domains/view_domain.hpp>
#include <lucent/kit/hook.hpp>
#include <lucent/kit/registry.hpp>

namespace lucent::cs2 {

// What the game thread's hooks borrow: each outlives them, and none is null.
struct game_thread_parts {
    kit::registry* features = nullptr;
    command_domain* command = nullptr;
    view_domain* view = nullptr;
};

// The hooks that run the command and view domains on the game's main thread: CreateMove, which
// opens the command, ticks the features on it and applies their intents, and FrameStageNotify,
// which turns the view. One whose capability is unavailable is left out, and its domain never
// runs. Call on the lifecycle thread before installing them; `parts` must outlive the hook_set
// holding them.
//
// The registry is ticked here and drawn by the present hook: one thread, since cs2 presents from
// its main loop (research/kb/cs2/game-thread.md).
auto game_thread_hooks(game_thread_parts parts) -> std::vector<kit::hook_request>;

}
