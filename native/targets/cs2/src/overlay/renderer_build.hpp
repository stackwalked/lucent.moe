#pragma once

#include <atomic>
#include <memory>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2::overlay {

// One renderer built on a kit worker, so the game's frame never waits for shaders and pipeline
// state to be made. The worker has the renderer from start() until has_landed(); then the
// presenting thread takes it back. build() touches the device only, which a device not made
// single-threaded allows from any thread.
//
// The worker holds this object's address: it is dropped only once it has landed, or after the
// worker set has been stopped.
class renderer_build final {
public:
    // Fails with error_code::closed once the worker set has begun stopping (the module unloads).
    static auto start(kit::worker_set& workers, d3d11::renderer built)
        -> result<std::unique_ptr<renderer_build>>;

    explicit renderer_build(d3d11::renderer built);
    renderer_build(const renderer_build&) = delete ("a worker holds its address");
    auto operator=(const renderer_build&)
        -> renderer_build& = delete ("a worker holds its address");
    renderer_build(renderer_build&&) = delete ("a worker holds its address");
    auto operator=(renderer_build&&) -> renderer_build& = delete ("a worker holds its address");
    ~renderer_build() = default;

    // The presenting thread.
    auto has_landed() const -> bool;
    // The presenting thread, once landed.
    auto take() -> d3d11::renderer;

private:
    // The worker.
    auto run() -> void;

    d3d11::renderer m_renderer;
    // The one thing both threads touch: set by the worker after its last use of m_renderer.
    std::atomic<bool> m_has_landed{false};
};

}
