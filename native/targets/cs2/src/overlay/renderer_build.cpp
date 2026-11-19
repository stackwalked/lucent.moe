#include "renderer_build.hpp"

#include <atomic>
#include <memory>
#include <stop_token>
#include <tuple>
#include <utility>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2::overlay {

auto renderer_build::start(kit::worker_set& workers, d3d11::renderer built)
    -> result<std::unique_ptr<renderer_build>> {
    auto job = std::make_unique<renderer_build>(std::move(built));
    // One bounded call: the stop token has nothing to cut short, and stop() waits for it.
    LUCENT_TRY(workers.start<"overlay renderer build">(
        [running = job.get()](const std::stop_token& /*stopping*/) { running->run(); }
    ));
    return job;
}

renderer_build::renderer_build(d3d11::renderer built)
    : m_renderer{std::move(built)} {}

auto renderer_build::has_landed() const -> bool {
    // Acquire: pairs with run()'s release, so the build's writes are seen before take().
    return m_has_landed.load(std::memory_order_acquire);
}

auto renderer_build::take() -> d3d11::renderer {
    LUCENT_INVARIANT(has_landed());
    return std::move(m_renderer);
}

auto renderer_build::run() -> void {
    // A failure is in the renderer's state, which the presenting thread reads once it lands.
    std::ignore = m_renderer.build();
    m_has_landed.store(true, std::memory_order_release);
}

}
