#include "key/seed.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <string>
#include <system_error>
#include <tuple>
#include <vector>

#include <Windows.h>
// After Windows.h, which defines the types bcrypt.h uses.
#include <bcrypt.h>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

namespace lucent::devkey {
namespace {

auto seed_directory() -> result<std::filesystem::path> {
    std::array<wchar_t, MAX_PATH> buffer{};
    const DWORD length =
        GetEnvironmentVariableW(L"LOCALAPPDATA", buffer.data(), narrow<DWORD>(std::ssize(buffer)));
    if (length == 0 || length >= buffer.size()) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    return std::filesystem::path{std::wstring{buffer.data(), length}} / L"lucent" / L"dev";
}

auto fresh_seed() -> result<crypto::seed> {
    crypto::seed material{};
    const NTSTATUS status = BCryptGenRandom(
        nullptr,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and UCHAR share one object representation; BCrypt takes PUCHAR.
        reinterpret_cast<PUCHAR>(material.data()),
        narrow<ULONG>(std::ssize(material)),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );
    if (!BCRYPT_SUCCESS(status)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = narrow<u32>(status)}
        );
    }
    return material;
}

// Written beside the seed and moved into place without replacing, so a concurrent build's seed
// wins or ours does, never half of each.
auto create_seed(const std::filesystem::path& seed) -> result<void> {
    const crypto::seed material = LUCENT_TRY(fresh_seed());
    const std::filesystem::path staged =
        std::filesystem::path{seed}.concat(std::format(L".{}.tmp", GetCurrentProcessId()));
    LUCENT_TRY(os::write_file(staged, material));
    if (MoveFileExW(staged.c_str(), seed.c_str(), MOVEFILE_WRITE_THROUGH) == 0) {
        const error failure = last_system_error();
        std::error_code ignored;
        std::ignore = std::filesystem::remove(staged, ignored);
        if (failure.system_code != ERROR_ALREADY_EXISTS) {
            return std::unexpected(failure);
        }
    }
    return {};
}

}

auto dev_signing_key() -> result<crypto::signing_key> {
    const std::filesystem::path directory = LUCENT_TRY(seed_directory());
    const std::filesystem::path seed = directory / L"fact-signing.seed";
    std::error_code failure;
    if (!std::filesystem::exists(seed, failure)) {
        std::filesystem::create_directories(directory, failure);
        LUCENT_TRY(create_seed(seed));
    }
    const std::vector<std::byte> stored = LUCENT_TRY(os::read_file(seed));
    if (stored.size() != crypto::seed_size) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    crypto::seed material{};
    std::ranges::copy(stored, material.begin());
    return crypto::signing_key::from_seed(material);
}

}
