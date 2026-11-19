#include "key/random.hpp"

#include <cstddef>
#include <expected>
#include <span>

#include <Windows.h>
// After Windows.h, which defines the types bcrypt.h uses.
#include <bcrypt.h>

#include <lucent/core/narrow.hpp>

namespace lucent::codekey {

auto fill_random(std::span<std::byte> out) -> result<void> {
    const NTSTATUS status = BCryptGenRandom(
        nullptr,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and UCHAR share one object representation; BCrypt takes PUCHAR.
        reinterpret_cast<PUCHAR>(out.data()),
        narrow<ULONG>(out.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );
    if (!BCRYPT_SUCCESS(status)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = narrow<u32>(status)}
        );
    }
    return {};
}

}
