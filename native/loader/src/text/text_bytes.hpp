#pragma once

#include <cstddef>
#include <span>
#include <string_view>

namespace lucent::loader {

// Bytes off the wire read as text, borrowed: the OAuth replies, the loopback request.
inline auto as_text(std::span<const std::byte> bytes) -> std::string_view {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): char may alias any object, std::byte included.
    return std::string_view{reinterpret_cast<const char*>(bytes.data()), bytes.size()};
}

inline auto as_bytes(std::string_view text) -> std::span<const std::byte> {
    return std::as_bytes(std::span{text});
}

}
