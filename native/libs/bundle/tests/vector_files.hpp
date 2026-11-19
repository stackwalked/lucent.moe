#pragma once

#include <array>
#include <cstddef>
#include <filesystem>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <Windows.h>

// What the golden vector tests share: each vector is a .bin and a .json under contracts/, compared
// byte for byte, and rewritten from the encoder only under LUCENT_WRITE_VECTORS=1.

namespace lucent::bundle::vectors {

inline auto hex(std::span<const std::byte> bytes) -> std::string {
    std::string out;
    for (const std::byte value : bytes) {
        out += std::format("{:02x}", static_cast<u8>(value));
    }
    return out;
}

// The vectors' JSON is fully expanded, one member or item per line, which is the layout the
// repo's JSON formatter keeps as it is.
struct json_field {
    std::string_view name;
    std::string value;
};

inline auto spaces(usize count) -> std::string {
    std::string padding;
    padding.resize(count, ' ');
    return padding;
}

inline auto json_string(std::string_view text) -> std::string {
    return std::format("\"{}\"", text);
}

inline auto object(const std::vector<json_field>& fields, usize indent) -> std::string {
    std::string out = "{\n";
    for (usize index = 0; const json_field& field : fields) {
        const std::string_view separator = index + 1 < fields.size() ? "," : "";
        out +=
            std::format("{}\"{}\": {}{}\n", spaces(indent + 2), field.name, field.value, separator);
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
        const std::string_view separator = index + 1 < items.size() ? "," : "";
        out += std::format("{}{}{}\n", spaces(indent + 2), item, separator);
        ++index;
    }
    return out + spaces(indent) + "]";
}

inline auto should_write() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_WRITE_VECTORS", value.data(), 2) == 1
           && value.front() == L'1';
}

inline auto as_text(std::span<const std::byte> bytes) -> std::string {
    std::string text;
    for (const std::byte value : bytes) {
        text.push_back(static_cast<char>(value));
    }
    return text;
}

// A contract's vector directory, such as "fact-bundle" / "v1".
inline auto directory_of(std::string_view contract) -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / contract / "v1";
}

// The same at another version, such as "release-manifest" / "v2".
inline auto directory_of(std::string_view contract, std::string_view version)
    -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / contract / version;
}

}
