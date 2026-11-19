#include "renderer_build.hpp"

#include <memory>
#include <optional>
#include <stop_token>
#include <tuple>
#include <utility>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/kit/handoff.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2::overlay {

auto renderer_build::start(kit::worker_set& workers, d3d11::renderer built)
    -> result<std::unique_ptr<renderer_build>> {
    auto job = std::make_unique<renderer_build>();
    // One bounded call: the stop token has nothing to cut short, and stop() waits for it.
    LUCENT_TRY(workers.start<"overlay renderer build">(
        [building = std::move(built),
            landing = &job->m_landed](const std::stop_token& /*stopping*/) mutable {
            // A failure is in the renderer's state, which the presenting thread reads once it
            // lands.
            std::ignore = building.build();
            landing->give(std::move(building));
        }
    ));
    return job;
}

auto renderer_build::take() -> std::optional<d3d11::renderer> {
    return m_landed.take();
}

}
