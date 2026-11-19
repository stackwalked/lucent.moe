#include "../src/session_end.hpp"

#include <atomic>
#include <chrono>
#include <optional>
#include <stop_token>
#include <thread>
#include <utility>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/session.hpp>
#include <lucent/os/unique_handle.hpp>

// A late core capability's failure ends the session from a kit worker while the lifecycle thread
// is blocked reading from a host that says nothing: missed, the module would run on without its
// core.

namespace lucent::kit::detail {
namespace {

struct pipe_ends {
    os::unique_handle read;
    os::unique_handle write;
};

auto make_pipe() -> pipe_ends {
    HANDLE read = nullptr;
    HANDLE write = nullptr;
    REQUIRE(CreatePipe(&read, &write, nullptr, 0) != FALSE);
    return pipe_ends{.read = os::unique_handle{read}, .write = os::unique_handle{write}};
}

// The lifecycle thread's side, shared with the test's thread.
struct reader {
    session* channel = nullptr;
    std::optional<session_end> ending;
    std::atomic<bool> is_ready = false;
    std::atomic<bool> has_returned = false;
};

// Reads from the host, as the lifecycle's wait for unload does, until the end is requested.
auto read_until_ended(reader& state) -> void {
    result<os::unique_handle> thread = current_thread();
    if (thread) {
        state.ending.emplace(std::move(*thread));
    }
    state.is_ready.store(true, std::memory_order_release);
    while (state.ending && !state.ending->is_requested()) {
        if (!state.channel->receive()) {
            break;
        }
    }
    state.has_returned.store(true, std::memory_order_release);
}

auto wait_for(const std::atomic<bool>& flag) -> bool {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{5};
    while (!flag.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() > deadline) {
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
    return true;
}

TEST_CASE("a requested end releases a thread blocked reading from a silent host") {
    pipe_ends from_host = make_pipe();
    pipe_ends to_host = make_pipe();
    session channel{
        session_ends{.inbound = std::move(from_host.read), .outbound = std::move(to_host.write)}
    };
    reader state{
        .channel = &channel,
        .ending = std::nullopt,
        .is_ready = false,
        .has_returned = false,
    };
    std::jthread lifecycle{[&state] { read_until_ended(state); }};
    REQUIRE(wait_for(state.is_ready));
    REQUIRE(state.ending.has_value());
    if (!state.ending) {
        return;
    }
    session_end& ending = *state.ending;
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    const bool was_reading_unasked = !state.has_returned.load(std::memory_order_acquire);

    std::stop_source stopper;
    std::jthread worker{[&ending, &stopper] { ending.request(stopper.get_token()); }};
    const bool returned = wait_for(state.has_returned);
    stopper.request_stop();
    worker.join();
    if (!returned) {
        // Unblocks the reader so the test can end; the check below has already failed.
        from_host.write = {};
    }
    lifecycle.join();

    CHECK(was_reading_unasked);
    CHECK(returned);
}

}
}
