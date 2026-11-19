#include <lucent/kit/worker_set.hpp>

#include <expected>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/os/unique_handle.hpp>

#include "dev.hpp"

namespace lucent::kit {

namespace detail {

struct worker {
    std::move_only_function<void(const std::stop_token&)> body;
    std::stop_source stopper;
    // Empty in release builds.
    std::string name;
    // Written by the worker's thread before it ends; read only once that thread is joined.
    std::optional<fault> ended_by;
    os::unique_handle thread;
};

}

namespace {

auto WINAPI worker_main(void* parameter) -> DWORD {
    detail::worker& running = *static_cast<detail::worker*>(parameter);
    const contained<void> ran = contain([&] { running.body(running.stopper.get_token()); });
    if (!ran) {
        running.ended_by = ran.error();
        if constexpr (is_dev_build) {
            detail::report_worker_fault(running.name, ran.error());
        }
    }
    return 0;
}

}

worker_set::worker_set() = default;

// A throw here is bad_alloc or a broken mutex; terminating is the right end for either.
// NOLINTNEXTLINE(bugprone-exception-escape)
worker_set::~worker_set() {
    std::ignore = stop();
}

auto worker_set::start_named(
    std::string_view name, std::move_only_function<void(const std::stop_token&)> body
) -> result<void> {
    auto started = std::make_unique<detail::worker>(detail::worker{
        .body = std::move(body),
        .stopper = {},
        .name = std::string{name},
        .ended_by = std::nullopt,
        .thread = {},
    });
    // Held while the thread is created, so stop() can't miss a worker started alongside it.
    const std::scoped_lock<std::mutex> locked{m_lock};
    if (m_is_stopping) {
        return std::unexpected(error{.code = error_code::closed});
    }
    started->thread =
        os::unique_handle{CreateThread(nullptr, 0, &worker_main, started.get(), 0, nullptr)};
    if (!started->thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    if constexpr (is_dev_build) {
        detail::name_thread(started->thread.native(), name);
    }
    m_workers.push_back(std::move(started));
    return {};
}

auto worker_set::stop() -> std::vector<fault> {
    std::vector<std::unique_ptr<detail::worker>> stopping;
    {
        const std::scoped_lock<std::mutex> locked{m_lock};
        m_is_stopping = true;
        stopping = std::exchange(m_workers, {});
    }
    // Outside the lock: a start() racing this is refused at once instead of waiting on the joins.
    for (const std::unique_ptr<detail::worker>& running : stopping) {
        running->stopper.request_stop();
    }
    std::vector<fault> faults;
    for (const std::unique_ptr<detail::worker>& running : stopping) {
        WaitForSingleObject(running->thread.native(), INFINITE);
        if (running->ended_by) {
            faults.push_back(*running->ended_by);
        }
    }
    return faults;
}

}
