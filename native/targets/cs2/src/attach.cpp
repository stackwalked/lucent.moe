#include "attach.hpp"

#include <array>
#include <memory>
#include <tuple>
#include <utility>

#include <lucent/kit/clock.hpp>
#include <lucent/kit/hook.hpp>
#include <lucent/kit/lifecycle.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/kit/worker_set.hpp>

#include "features/all.hpp"
#include "overlay/overlay.hpp"
#include "overlay/present.hpp"

namespace lucent::cs2 {
namespace {

// Each part at an address the next one borrows: the registry the clock's, the overlay both.
struct attached_parts {
    std::unique_ptr<kit::monotonic_clock> time;
    // Ticked by the present hook for now (overlay::draw); the world domain's hook takes it over.
    std::unique_ptr<kit::registry> features;
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
        std::ignore = m_parts.features.release();
        std::ignore = m_parts.time.release();
    }

    attached_parts m_parts;
};

}

auto attach(kit::worker_set& workers) -> result<std::unique_ptr<kit::attachment>> {
    kit::wiring wired;
    features::wire(wired);
    auto time = std::make_unique<kit::monotonic_clock>();
    auto features =
        std::make_unique<kit::registry>(std::move(wired), kit::default_entitlements(), *time);
    auto drawn = std::make_unique<overlay::overlay>(workers, *features, *time);
    const std::array requests{LUCENT_TRY(overlay::present_hook(*drawn))};
    kit::hook_set hooks = LUCENT_TRY(kit::hook_set::install(requests));
    return std::make_unique<attached>(attached_parts{
        .time = std::move(time),
        .features = std::move(features),
        .drawn = std::move(drawn),
        .hooks = std::move(hooks),
    });
}

}
