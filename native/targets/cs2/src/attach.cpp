#include "attach.hpp"

#include <array>
#include <memory>
#include <utility>

#include <lucent/kit/hook.hpp>
#include <lucent/kit/lifecycle.hpp>
#include <lucent/kit/worker_set.hpp>

#include "overlay/present.hpp"

namespace lucent::cs2 {
namespace {

class attached final : public kit::attachment {
public:
    explicit attached(kit::hook_set hooks)
        : m_hooks{std::move(hooks)} {}

    auto detach() -> result<void> override {
        return m_hooks.remove(kit::unhook_patience);
    }

private:
    kit::hook_set m_hooks;
};

}

auto attach(kit::worker_set& /*workers*/) -> result<std::unique_ptr<kit::attachment>> {
    const std::array requests{LUCENT_TRY(overlay::present_hook())};
    kit::hook_set hooks = LUCENT_TRY(kit::hook_set::install(requests));
    return std::make_unique<attached>(std::move(hooks));
}

}
