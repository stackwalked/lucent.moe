#pragma once

#include <flat_map>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

enum class export_ordinal : u16 {};

struct export_address {
    u32 rva = 0;

    auto operator==(const export_address&) const -> bool = default;
};

// An export that lives in another module: "NTDLL.RtlAllocateHeap" or "NTDLL.#42". The module is
// named as written there, without its extension.
struct forwarder {
    std::string module;
    std::variant<std::string, export_ordinal> target;

    auto operator==(const forwarder&) const -> bool = default;
};

using export_target = std::variant<export_address, forwarder>;

// An image's exports, read once and looked up by name or ordinal.
class export_table final {
public:
    static auto from_image(const image_view& image) -> result<export_table>;

    auto find(std::string_view name) const -> result<export_target>;
    auto find(export_ordinal ordinal) const -> result<export_target>;
    auto ordinal_of(std::string_view name) const -> result<export_ordinal>;

private:
    export_table() = default;

    u32 m_ordinal_base = 0;
    // By ordinal minus the base; empty where the image leaves an ordinal unused.
    std::vector<std::optional<export_target>> m_targets;
    std::flat_map<std::string, u32, std::less<>> m_index_of_name;
};

}
