#include <lucent/kit/dev_channel.hpp>

#include <atomic>
#include <format>
#include <string>
#include <string_view>
#include <tuple>

#include <Windows.h>

#include <lucent/core/fault.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>

#include "dev.hpp"

// Dev builds only: kit's CMakeLists leaves this file out of every other configuration.

namespace lucent::kit {
namespace {

// Owned by the lifecycle thread, which publishes its session here for the length of its run.
// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables): senders on any thread need the session the lifecycle owns.
constinit std::atomic<session*> published{nullptr};
// Sends under way, so withdrawing can wait them out before the session goes.
constinit std::atomic<i32> sending{0};
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables)

auto name_of(fault_kind kind) -> std::string_view {
    switch (kind) {
    case fault_kind::ensure_failed:
        return "ensure failed";
    case fault_kind::access_violation:
        return "access violation";
    case fault_kind::page_error:
        return "page error";
    case fault_kind::misaligned:
        return "misaligned access";
    }
    return "unknown fault";
}

auto describe(const fault& caught) -> std::string {
    if (caught.kind == fault_kind::ensure_failed) {
        return std::format(
            "{} at {}:{} (rva {:#x})",
            name_of(caught.kind),
            caught.where.file_name(),
            caught.where.line(),
            caught.check
        );
    }
    return std::format(
        "{} at {:#x} ({} {:#x})",
        name_of(caught.kind),
        caught.instruction,
        caught.is_write ? "writing" : "reading",
        caught.address
    );
}

}

namespace detail {

auto publish_dev_session(session& channel) -> void {
    published.store(&channel, std::memory_order_release);
}

auto withdraw_dev_session() -> void {
    // seq_cst pairs with the sender's increment-then-load: either the sender saw no session, or
    // this load sees its count.
    published.store(nullptr, std::memory_order_seq_cst);
    while (sending.load(std::memory_order_seq_cst) != 0) {
        Sleep(1);
    }
}

}

namespace dev {

auto send_text(std::string_view line) -> void {
    // seq_cst: see withdraw_dev_session.
    sending.fetch_add(1, std::memory_order_seq_cst);
    if (session* const channel = published.load(std::memory_order_seq_cst); channel != nullptr) {
        // A failed send means the host is gone; the lifecycle sees that on its own.
        std::ignore = channel->send(dev_text{.text = std::string{line}});
    }
    sending.fetch_sub(1, std::memory_order_release);
}

auto report_incident(std::string_view what, const fault& caught) -> void {
    send_text(std::format("incident: {}: {}", what, describe(caught)));
}

}

}
