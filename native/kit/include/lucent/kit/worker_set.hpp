#pragma once

#include <algorithm>
#include <array>
#include <functional>
#include <memory>
#include <mutex>
#include <stop_token>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/core/fault.hpp>
#include <lucent/kit/dev_build.hpp>

namespace lucent::kit {

// A worker's name, written as a string literal template argument: `workers.start<"name">(...)`.
// Dev builds name the thread with it; release builds never instantiate the code that reads it, so
// the name never reaches their image.
template <usize Size>
class worker_name final {
public:
    // NOLINTNEXTLINE(google-explicit-constructor,cppcoreguidelines-explicit-constructor,misc-explicit-constructor,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): converts the literal at the call site.
    consteval worker_name(const char (&literal)[Size]) {
        std::ranges::copy(literal, chars.begin());
    }

    constexpr auto view() const -> std::string_view {
        return std::string_view{chars.data(), Size - 1};
    }

    // Public: a class used as a template argument may have no private data.
    std::array<char, Size> chars{};
};

// NOLINTBEGIN(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): deduces Size from the literal.
template <usize Size>
worker_name(const char (&literal)[Size]) -> worker_name<Size>;
// NOLINTEND(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays)

namespace detail {

struct worker;

}

// The module's own threads. Each runs one body inside contain() and is joined by stop(). The
// lifecycle owns the module's set and stops it before detach removes hooks and before the module
// is freed, so no worker races hook removal or outlives the code it runs.
class worker_set final {
public:
    worker_set();
    worker_set(const worker_set&) = delete ("owns its threads");
    auto operator=(const worker_set&) -> worker_set& = delete ("owns its threads");
    worker_set(worker_set&&) = delete ("its workers are joined where it was started");
    auto operator=(worker_set&&) -> worker_set& = delete ("joined where it was started");
    // Stops what stop() hasn't.
    ~worker_set();

    // Starts a thread running body once, inside contain(), with a token that stop() trips. A fault
    // ends only that worker: dev builds report it as an incident, stop() returns it. Any thread;
    // fails with error_code::closed once stop() has begun.
    template <worker_name Name>
    auto start(std::move_only_function<void(const std::stop_token&)> body) -> result<void> {
        if constexpr (is_dev_build) {
            return start_named(Name.view(), std::move(body));
        } else {
            return start_named({}, std::move(body));
        }
    }

    // Trips every worker's stop token and waits for each body to return, so a body must watch its
    // token. Returns the faults that ended any. Never from a worker of this set: it would wait on
    // itself.
    auto stop() -> std::vector<fault>;

private:
    auto start_named(
        std::string_view name, std::move_only_function<void(const std::stop_token&)> body
    ) -> result<void>;

    std::mutex m_lock;
    std::vector<std::unique_ptr<detail::worker>> m_workers;
    bool m_is_stopping = false;
};

}
