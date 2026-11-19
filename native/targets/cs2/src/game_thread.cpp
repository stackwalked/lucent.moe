#include "game_thread.hpp"

#include <tuple>
#include <vector>

#include <lucent/core/contain.hpp>
#include <lucent/cs2-domains/command_domain.hpp>
#include <lucent/cs2-domains/foreign/input.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/cs2-domains/view_domain.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/hook.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::cs2 {
namespace {

// The attachment's game thread parts. Written by game_thread_hooks() before the hooks are
// installed, which publishes them to the detours (install stores the original with release, the
// detour loads it with acquire), and read only by the detours, on the game's main thread.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the plain functions the game calls can reach them no other way; the attachment owns what they point at.
constinit game_thread_parts running{};

// Set by a domain's fault: it stays off for the session, and the game runs as if unhooked.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): game thread only, owned by the hooks above.
constinit bool is_faulted = false;

// The split-screen slot whose command the local player drives; the others' calls touch nothing.
constexpr i32 first_slot = 0;

auto run_tick() -> void {
    kit::view_set parts;
    if (!contain([&parts] {
            running.command->open();
            running.command->put_parts(parts, running.view->model());
            running.view->put_parts(parts, running.command->tick());
        })) {
        is_faulted = true;
        return;
    }
    running.features->dispatch(parts);
    if (!contain([] {
            if (running.command->apply(running.view->model().owed())) {
                std::ignore = running.view->model().settle();
            }
        })) {
        is_faulted = true;
    }
}

using create_move_call = kit::hook_access<void(foreign::ccsgo_input*, i32)>;

auto on_create_move(const create_move_call& call, foreign::ccsgo_input* input, i32 slot) -> void {
    call.original(input, slot);
    if (slot != first_slot || is_faulted) {
        return;
    }
    run_tick();
}

using frame_stage_call = kit::hook_access<void(foreign::source2_client*, i32)>;

auto on_frame_stage(const frame_stage_call& call, foreign::source2_client* client, i32 stage)
    -> void {
    call.original(client, stage);
    if (is_faulted) {
        return;
    }
    if (!contain([] { running.view->apply(); })) {
        is_faulted = true;
    }
}

// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables): a hook slot is a constinit global by design; the hook_set owns it while installed.
constinit kit::hook_slot<void(foreign::ccsgo_input*, i32)> create_move{&on_create_move};
constinit kit::hook_slot<void(foreign::source2_client*, i32)> frame_stage{&on_frame_stage};
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables)

}

auto game_thread_hooks(game_thread_parts parts) -> std::vector<kit::hook_request> {
    running = parts;
    std::vector<kit::hook_request> requests;
    if (kit::is_available(foreign::create_move_hook{})) {
        requests.push_back(
            kit::hook_on<
                create_move,
                foreign::input_create_move,
                foreign::input_vtable,
                foreign::input_create_move_slot>()
        );
    }
    if (kit::is_available(foreign::frame_stage_hook{})) {
        requests.push_back(
            kit::hook_on<
                frame_stage,
                foreign::frame_stage_notify,
                foreign::client_vtable,
                foreign::frame_stage_notify_slot>()
        );
    }
    return requests;
}

}
