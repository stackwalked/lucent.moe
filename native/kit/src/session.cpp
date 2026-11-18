#include <lucent/kit/session.hpp>

#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/session_message.hpp>

namespace lucent::kit {
namespace {

constexpr error closed{.code = error_code::closed};

auto failure_of_last_call() -> error {
    const error failure = last_system_error();
    return failure.system_code == ERROR_BROKEN_PIPE ? closed : failure;
}

auto write_all(void* pipe, std::span<const std::byte> bytes) -> result<void> {
    while (!bytes.empty()) {
        DWORD written = 0;
        const auto size = narrow<DWORD>(std::ssize(bytes));
        if (WriteFile(pipe, bytes.data(), size, &written, nullptr) == 0) {
            return std::unexpected(failure_of_last_call());
        }
        bytes = bytes.subspan(written);
    }
    return {};
}

auto read_exact(void* pipe, std::span<std::byte> into) -> result<void> {
    while (!into.empty()) {
        DWORD read = 0;
        const auto size = narrow<DWORD>(std::ssize(into));
        if (ReadFile(pipe, into.data(), size, &read, nullptr) == 0) {
            return std::unexpected(failure_of_last_call());
        }
        // A successful read of nothing is end of stream: the writer closed between frames.
        if (read == 0) {
            return std::unexpected(closed);
        }
        into = into.subspan(read);
    }
    return {};
}

}

session::session(session_ends ends)
    : m_inbound(std::move(ends.inbound))
    , m_outbound(std::move(ends.outbound)) {}

auto session::send(const session_message& message) -> result<void> {
    return write_all(m_outbound.native(), encode(message));
}

auto session::receive() -> result<session_message> {
    std::array<std::byte, frame_header_size> header{};
    LUCENT_TRY(read_exact(m_inbound.native(), header));
    const isize size = LUCENT_TRY(decode_frame_size(header));
    std::vector<std::byte> body(narrow<usize>(size));
    LUCENT_TRY(read_exact(m_inbound.native(), body));
    return decode(body);
}

}
