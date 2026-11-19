#include "attach.hpp"

#include <memory>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <lucent/cs2-domains/command_domain.hpp>
#include <lucent/cs2-domains/view_domain.hpp>
#include <lucent/cs2-domains/world_domain.hpp>
#include <lucent/cs2-features/all.hpp>
#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/config_store.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/hook.hpp>
#include <lucent/kit/lifecycle.hpp>
#include <lucent/kit/memory_storage.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/kit/worker_set.hpp>

#include "game_thread.hpp"
#include "overlay/overlay.hpp"
#include "overlay/present.hpp"

namespace lucent::cs2 {
namespace {

// Each part at an address the next one borrows: the registry the clock's, the overlay both.
struct attached_parts {
    std::unique_ptr<kit::monotonic_clock> time;
    // Ticked by the present hook for now (overlay::draw), until a hook at the game's frame stage.
    std::unique_ptr<kit::registry> features;
    // In memory until the cloud holds configs (phase 4).
    std::unique_ptr<kit::memory_storage> kept;
    // Used on the presenting thread, by the menu.
    std::unique_ptr<kit::config_store> configs;
    // Updated by the present hook too (overlay::draw), for the same reason.
    std::unique_ptr<world_domain> world;
    // Run by the CreateMove and FrameStageNotify hooks, on the game's main thread.
    std::unique_ptr<command_domain> command;
    std::unique_ptr<view_domain> view;
    std::unique_ptr<overlay::overlay> drawn;
    kit::hook_set hooks;
};

class attached final : public kit::attachment {
public:
    explicit attached(attached_parts parts)
        : m_parts{std::move(parts)} {}

    // The present hook goes first, so nothing subclasses the window again; then the window gets
    // its procedure back and the calls inside ours drain; only then is the overlay freed.
    auto detach() -> result<void> override {
        if (const result<void> removed = m_parts.hooks.remove(kit::unhook_patience); !removed) {
            abandon();
            return removed;
        }
        if (const result<void> restored = m_parts.drawn->unsubclass(kit::unhook_patience);
            !restored) {
            abandon();
            return restored;
        }
        // The workers were stopped before detach, so no build still holds the renderer.
        m_parts.drawn.reset();
        return {};
    }

private:
    // A thread may still be in the present detour or the window procedure, which read the overlay
    // and the registry: they stay allocated, like the module that stays loaded.
    auto abandon() -> void {
        std::ignore = m_parts.drawn.release();
        std::ignore = m_parts.view.release();
        std::ignore = m_parts.command.release();
        std::ignore = m_parts.world.release();
        std::ignore = m_parts.configs.release();
        std::ignore = m_parts.kept.release();
        std::ignore = m_parts.features.release();
        std::ignore = m_parts.time.release();
    }

    attached_parts m_parts;
};

// The builds a failing feature records, taken once at attach. A module the game loads later (the
// resolve stage lets attach run before it) is missing from them until something feeds the
// registry again.
auto loaded_builds() -> kit::replace_module_builds {
    kit::replace_module_builds loaded_now;
    for (const kit::loaded_module& loaded : kit::loaded_game_modules(game_modules)) {
        loaded_now.builds.push_back(loaded.build);
    }
    return loaded_now;
}

}

auto attach(kit::worker_set& workers, const kit::domain_token& opens)
    -> result<std::unique_ptr<kit::attachment>> {
    kit::wiring wired;
    features::wire(wired);
    auto time = std::make_unique<kit::monotonic_clock>();
    auto features =
        std::make_unique<kit::registry>(std::move(wired), kit::default_entitlements(), *time);
    features->request({loaded_builds()});
    auto kept = std::make_unique<kit::memory_storage>();
    // The first profile's name is the person's to change; until then the menu shows it empty.
    auto configs = std::make_unique<kit::config_store>(*features, *kept, std::string{});
    auto world =
        std::make_unique<world_domain>(opens, lucent::foreign::memory_source::this_process());
    auto drawn = std::make_unique<overlay::overlay>(overlay::overlay_parts{
        .workers = &workers,
        .features = features.get(),
        .configs = configs.get(),
        .world = world.get(),
        .time = time.get(),
    });
    auto command =
        std::make_unique<command_domain>(opens, lucent::foreign::memory_source::this_process());
    auto view =
        std::make_unique<view_domain>(opens, lucent::foreign::memory_source::this_process());
    std::vector<kit::hook_request> requests = game_thread_hooks({
        .features = features.get(),
        .command = command.get(),
        .view = view.get(),
    });
    requests.push_back(LUCENT_TRY(overlay::present_hook(*drawn)));
    kit::hook_set hooks = LUCENT_TRY(kit::hook_set::install(requests));
    return std::make_unique<attached>(attached_parts{
        .time = std::move(time),
        .features = std::move(features),
        .kept = std::move(kept),
        .configs = std::move(configs),
        .world = std::move(world),
        .command = std::move(command),
        .view = std::move(view),
        .drawn = std::move(drawn),
        .hooks = std::move(hooks),
    });
}

}
