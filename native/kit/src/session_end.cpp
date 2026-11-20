#include "session_end.hpp"

#include <atomic>
#include <expected>
#include <stop_token>
#include <tuple>
#include <utility>

#include <Windows.h>

#include <lucent/os/unique_handle.hpp>
#include <lucent/wire/refusal.hpp>

namespace lucent::kit::detail {

session_end::session_end(os::unique_handle lifecycle_thread)
    : m_thread{std::move(lifecycle_thread)} {}

auto session_end::is_requested() const -> bool {
    // seq_cst pairs with request()'s store: either this load sees the mark, or the read that
    // follows it is under way when a later cancel lands.
    return m_is_requested.load(std::memory_order_seq_cst);
}

auto session_end::request(const std::stop_token& stop, wire::refusal_code why) -> void {
    u8 none = 0;
    // Relaxed: the seq_cst store of the mark below publishes it to is_requested()'s reader.
    std::ignore = m_reason.compare_exchange_strong(
        none, std::to_underlying(why), std::memory_order_relaxed, std::memory_order_relaxed
    );
    m_is_requested.store(true, std::memory_order_seq_cst);
    while (!stop.stop_requested()) {
        // Fails with ERROR_NOT_FOUND while nothing is pending; the loop tries again.
        CancelSynchronousIo(m_thread.native());
        Sleep(1);
    }
}

auto session_end::reason() const -> wire::refusal_code {
    // Relaxed: read only after is_requested()'s seq_cst load saw the mark stored after it.
    return static_cast<wire::refusal_code>(m_reason.load(std::memory_order_relaxed));
}

auto current_thread() -> result<os::unique_handle> {
    HANDLE duplicated = nullptr;
    const BOOL is_duplicated = DuplicateHandle(
        GetCurrentProcess(),
        GetCurrentThread(),
        GetCurrentProcess(),
        &duplicated,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS
    );
    if (is_duplicated == FALSE) {
        return std::unexpected(last_system_error());
    }
    return os::unique_handle{duplicated};
}

}
