#pragma once

#include <cstddef>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// The golden vectors' .json side: hex for bytes, u64s as 16 hex digits, and objects and arrays
// laid out the way the repo's JSON formatter keeps them.

namespace lucent::wire {
inline auto hex(std::span<const std::byte> bytes) -> std::string {
    std::string out;
    for (const std::byte value : bytes) {
        out += std::format("{:02x}", static_cast<u8>(value));
    }
    return out;
}

inline auto json_string(std::string_view text) -> std::string {
    return std::format("\"{}\"", text);
}

inline auto hex_field(std::span<const std::byte> bytes) -> std::string {
    return json_string(hex(bytes));
}

inline auto u64_field(u64 value) -> std::string {
    return json_string(std::format("{:016x}", value));
}

struct field {
    std::string_view name;
    std::string value;
};

inline auto spaces(usize count) -> std::string {
    std::string padding;
    padding.resize(count, ' ');
    return padding;
}

// Fully expanded, one member or item per line: the layout the repo's JSON formatter keeps.
inline auto object(const std::vector<field>& fields, usize indent) -> std::string {
    std::string out = "{\n";
    for (usize index = 0; const field& each : fields) {
        out += std::format(
            "{}\"{}\": {}{}\n",
            spaces(indent + 2),
            each.name,
            each.value,
            index + 1 < fields.size() ? "," : ""
        );
        ++index;
    }
    return out + spaces(indent) + "}";
}

inline auto array(const std::vector<std::string>& items, usize indent) -> std::string {
    if (items.empty()) {
        return "[]";
    }
    std::string out = "[\n";
    for (usize index = 0; const std::string& item : items) {
        out +=
            std::format("{}{}{}\n", spaces(indent + 2), item, index + 1 < items.size() ? "," : "");
        ++index;
    }
    return out + spaces(indent) + "]";
}

}
