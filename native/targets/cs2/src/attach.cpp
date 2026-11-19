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

class attached final : public kit::attachment {
public:
    attached(kit::wiring wired, std::unique_ptr<overlay::overlay> drawn, kit::hook_set hooks)
        : m_features{std::move(wired), kit::default_entitlements(), m_clock}
        , m_overlay{std::move(drawn)}
        , m_hooks{std::move(hooks)} {}

    auto detach() -> result<void> override {
        if (const result<void> removed = m_hooks.remove(kit::unhook_patience); !removed) {
            // A thread may still be in the detour, which reads the overlay: it stays allocated,
            // like the module that stays loaded.
            std::ignore = m_overlay.release();
            return removed;
        }
        // The workers were stopped before detach, so no build still holds the renderer.
        m_overlay.reset();
        return {};
    }

private:
    kit::monotonic_clock m_clock;
    // Nothing ticks it yet: its safe point and dispatch come with the world domain's hook.
    kit::registry m_features;
    std::unique_ptr<overlay::overlay> m_overlay;
    kit::hook_set m_hooks;
};

}

auto attach(kit::worker_set& workers) -> result<std::unique_ptr<kit::attachment>> {
    kit::wiring wired;
    features::wire(wired);
    auto drawn = std::make_unique<overlay::overlay>(workers);
    const std::array requests{LUCENT_TRY(overlay::present_hook(*drawn))};
    kit::hook_set hooks = LUCENT_TRY(kit::hook_set::install(requests));
    return std::make_unique<attached>(std::move(wired), std::move(drawn), std::move(hooks));
}

}
