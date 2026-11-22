#include "build/inputs.hpp"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <string_view>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

#include "text/base64url.hpp"

namespace lucent::loader {
namespace {

// CMake checked each one's alphabet and length (cmake/lucent.cmake); empty where the build has
// none.
// NOLINTBEGIN(readability-redundant-string-init): the macros are values in some builds only.
constexpr std::string_view configured_code_key = LUCENT_LOADER_CODE_PUBLIC_KEY;
constexpr std::string_view configured_release = LUCENT_LOADER_RELEASE_ID;
constexpr std::string_view configured_api = LUCENT_LOADER_API_ORIGIN;
constexpr std::string_view configured_web = LUCENT_LOADER_WEB_ORIGIN;
// NOLINTEND(readability-redundant-string-init)

}

auto code_key() -> std::optional<crypto::public_key> {
    const std::optional<std::vector<std::byte>> decoded = from_base64url(configured_code_key);
    if (!decoded || decoded->size() != crypto::public_key_size) {
        return std::nullopt;
    }
    crypto::public_key key{};
    std::ranges::copy(*decoded, key.begin());
    return key;
}

auto own_release() -> std::optional<wire::release_id> {
    const std::optional<std::vector<std::byte>> decoded = from_hex(configured_release);
    if (!decoded || decoded->size() != wire::id_size) {
        return std::nullopt;
    }
    wire::release_id release;
    std::ranges::copy(*decoded, release.bytes.begin());
    return release;
}

auto server_origins() -> origins {
    return origins{.api = configured_api, .web = configured_web};
}

}
