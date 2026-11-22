#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace lucent::loader {

// RFC 4648 §5 without padding, as JOSE (RFC 7515 §2) and the platform's ids spell it.
auto to_base64url(std::span<const std::byte> bytes) -> std::string;

// Canonical or nothing: only the URL alphabet, no padding, and zero leftover bits, so one value
// has one spelling.
auto from_base64url(std::string_view text) -> std::optional<std::vector<std::byte>>;

// Lowercase, two digits a byte, as /v1 paths spell ids and digests.
auto to_hex(std::span<const std::byte> bytes) -> std::string;

// Exactly two lowercase digits a byte.
auto from_hex(std::string_view text) -> std::optional<std::vector<std::byte>>;

}
