#include <lucent/cs2-features/quick_turn.hpp>

#include <catch2/catch_test_macros.hpp>

#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/cs2-domains/view_state.hpp>
#include <lucent/cs2-domains/view_turns.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/view_set.hpp>

// A turn asked for again on every tick its bind holds would spin the player; one never asked
// would do nothing. Checked against what the view is asked for over a few ticks.

namespace lucent::cs2::features {
namespace {

// One tick: the view part and the turns token over the model, as the view domain hands them.
auto run_at(quick_turn& running, mouse_model& view, i64 tick, quick_turn_settings chosen) -> void {
    const view_state state{
        .now = {.pitch = 0.0F, .yaw = 0.0F},
        .per_count = {.pitch = 0.022F, .yaw = -0.022F},
        .tick = tick,
    };
    const view_turns turns{view};
    kit::view_set parts;
    parts.put(state);
    parts.put(turns);
    running.tick(kit::context<quick_turn>{parts, chosen});
}

}

TEST_CASE("each run its bind starts asks the view for one turn, however long it runs") {
    quick_turn running;
    mouse_model view;

    run_at(running, view, 5, {});
    run_at(running, view, 6, {});
    run_at(running, view, 7, {});

    CHECK(view.pending().yaw == 180.0F);
    CHECK(view.pending().pitch == 0.0F);
}

TEST_CASE("starting again after a gap asks for another turn, by the chosen amount") {
    quick_turn running;
    mouse_model view;
    quick_turn_settings chosen;
    chosen.degrees = -90.0F;

    run_at(running, view, 5, chosen);
    run_at(running, view, 9, chosen);

    CHECK(-view.pending().yaw == 180.0F);
}

}
