#pragma once

#include <expected>
#include <utility>

namespace lucent {

// What went wrong, for the whole codebase. Codes and numbers only, so release binaries carry no
// failure strings.
enum class error_code : u8 {
    // A Windows call failed; system_code holds its GetLastError() value.
    system,
    // The peer closed its end of a channel.
    closed,
    // Bytes from outside did not form a valid value.
    malformed,
    not_found,
    // The peer speaks a different version of a format.
    version_mismatch,
    // Well-formed, but something we don't handle (another machine type, say).
    unsupported,
    // A wait ran out before the other side finished.
    timed_out,
};

struct error {
    error_code code = error_code::system;
    u32 system_code = 0;

    auto operator==(const error&) const -> bool = default;
};

// Unconstrained on purpose: a constraint is checked where the alias is named, and a class's own
// named constructor names result<T> while T is still incomplete.
template <typename T>
using result = std::expected<T, error>;

// The calling thread's last Windows error, as an error_code::system.
auto last_system_error() -> error;

}

// Yields the value of a successful result, or returns its error from the enclosing function:
// `const T value = LUCENT_TRY(f());`, or `LUCENT_TRY(g());` for a result<void>. A GNU statement
// expression: the one extension the dialect allows, and only inside this macro.
#define LUCENT_TRY(expression)                                                                     \
    ({                                                                                             \
        auto&& lucent_try_result = (expression);                                                   \
        if (!lucent_try_result) {                                                                  \
            return ::std::unexpected(::std::move(lucent_try_result).error());                      \
        }                                                                                          \
        *::std::move(lucent_try_result);                                                           \
    })
