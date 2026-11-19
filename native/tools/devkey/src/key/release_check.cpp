#include "key/release_check.hpp"

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <iterator>
#include <optional>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

namespace lucent::devkey {

auto public_key_offset(const std::filesystem::path& module, const crypto::public_key& key)
    -> result<std::optional<isize>> {
    const std::vector<std::byte> image = LUCENT_TRY(os::read_file(module));
    const auto found = std::ranges::search(image, key);
    if (found.empty()) {
        return std::nullopt;
    }
    return std::optional<isize>{std::distance(image.begin(), found.begin())};
}

}
