#pragma once

#include <memory>
#include <optional>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/kit/handoff.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2::overlay {

// One renderer built on a kit worker, so the game's frame never waits for shaders and pipeline
// state to be made. The worker owns the renderer until it hands it back built; build() touches the
// device only, which a device not made single-threaded allows from any thread.
//
// The worker holds this object's address: it is dropped only once the renderer is taken, or
// after the worker set has been stopped.
class renderer_build final {
public:
    // Fails with error_code::closed once the worker set has begun stopping (the module unloads).
    static auto start(kit::worker_set& workers, d3d11::renderer built)
        -> result<std::unique_ptr<renderer_build>>;

    renderer_build() = default;
    renderer_build(const renderer_build&) = delete ("a worker holds its address");
    auto operator=(const renderer_build&)
        -> renderer_build& = delete ("a worker holds its address");
    renderer_build(renderer_build&&) = delete ("a worker holds its address");
    auto operator=(renderer_build&&) -> renderer_build& = delete ("a worker holds its address");
    ~renderer_build() = default;

    // The presenting thread: the built renderer, once, as soon as the worker is done with it.
    auto take() -> std::optional<d3d11::renderer>;

private:
    kit::handoff<d3d11::renderer> m_landed;
};

}
