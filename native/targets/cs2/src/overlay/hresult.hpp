#pragma once

#include <bit>
#include <expected>

#include <Windows.h>

namespace lucent::cs2::overlay {

// An HRESULT as a result: a failure carries it as the system code (an HRESULT, not a
// GetLastError() value; both are Windows' codes for what went wrong).
inline auto checked(HRESULT code) -> result<void> {
    if (FAILED(code)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(code)}
        );
    }
    return {};
}

}
