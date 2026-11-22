#include "cng/random.hpp"

#include <cstddef>
#include <span>
#include <string>
#include <vector>

#include <Windows.h>

#include <bcrypt.h>

#include <lucent/core/narrow.hpp>

#include "text/base64url.hpp"

namespace lucent::loader {

auto fill_random(std::span<std::byte> into) -> void {
    const NTSTATUS status = BCryptGenRandom(
        nullptr,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and UCHAR share one object representation; CNG takes PUCHAR.
        reinterpret_cast<PUCHAR>(into.data()),
        narrow<ULONG>(into.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );
    LUCENT_INVARIANT(BCRYPT_SUCCESS(status));
}

auto random_token(usize byte_count) -> std::string {
    std::vector<std::byte> bytes(byte_count);
    fill_random(bytes);
    return to_base64url(bytes);
}

}
