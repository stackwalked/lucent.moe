#include "cng/sha256.hpp"

#include <cstddef>
#include <span>

#include <Windows.h>

#include <bcrypt.h>

#include <lucent/core/narrow.hpp>

namespace lucent::loader {

auto sha256(std::span<const std::byte> message) -> sha256_digest {
    sha256_digest digest{};
    // A pseudo-handle: nothing to open or close.
    const NTSTATUS status = BCryptHash(
        BCRYPT_SHA256_ALG_HANDLE,
        nullptr,
        0,
        // BCryptHash takes PUCHAR for its input but only reads through it.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast,cppcoreguidelines-pro-type-reinterpret-cast): see above
        const_cast<PUCHAR>(reinterpret_cast<const UCHAR*>(message.data())),
        narrow<ULONG>(message.size()),
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and UCHAR share one object representation; CNG takes PUCHAR.
        reinterpret_cast<PUCHAR>(digest.data()),
        narrow<ULONG>(digest.size())
    );
    LUCENT_INVARIANT(BCRYPT_SUCCESS(status));
    return digest;
}

}
