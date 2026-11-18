#include "imports.hpp"

#include <cstddef>
#include <expected>
#include <filesystem>
#include <flat_map>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/os/modules.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>

#include "image_bytes.hpp"

namespace lucent::manualmap::detail {
namespace {

// Real chains are one hop (kernel32 to ntdll); the bound only stops a cycle.
constexpr u32 max_forwarding_hops = 8;

// Enough to hold any module's headers.
constexpr usize header_page_size = 0x1000;

// What to look up in a module's exports.
using symbol = std::variant<std::string, pe::export_ordinal>;

auto symbol_of(const pe::import_target& target) -> symbol {
    return match(
        target,
        [](const pe::import_by_name& by_name) { return symbol{by_name.name}; },
        [](pe::export_ordinal ordinal) { return symbol{ordinal}; }
    );
}

auto lowercase(std::string_view text) -> std::string {
    const auto lower = [](char character) {
        return character >= 'A' && character <= 'Z' ? static_cast<char>(character - 'A' + 'a')
                                                    : character;
    };
    return text | std::views::transform(lower) | std::ranges::to<std::string>();
}

// The file the loader of this process loads for `name`; API set names ("api-ms-win-...") resolve to
// the DLL that implements them. Host and target run on the same system and resolve alike. Mapped
// without running anything, and only as long as it takes to read the path.
auto library_path(std::string_view name) -> result<std::filesystem::path> {
    const std::wstring wide = to_wide(name);
    const HMODULE module = LoadLibraryExW(wide.c_str(), nullptr, DONT_RESOLVE_DLL_REFERENCES);
    if (module == nullptr) {
        return std::unexpected(last_system_error());
    }
    std::wstring path(UNICODE_STRING_MAX_CHARS, L'\0');
    const DWORD size = GetModuleFileNameW(module, path.data(), narrow<DWORD>(path.size()));
    const error failure = last_system_error();
    FreeLibrary(module);
    if (size == 0 || size >= path.size()) {
        return std::unexpected(failure);
    }
    path.resize(size);
    return std::filesystem::path{std::move(path)};
}

// Modules in the target and their exports, each read at most once while one image is mapped.
class resolver final {
public:
    explicit resolver(const os::process& target)
        : m_target(&target) {}

    // The address in the target of an export, following forwarders to the module that has it.
    auto resolve(std::string_view module, symbol wanted) -> result<uptr> {
        uptr base = LUCENT_TRY(module_base(module));
        for (u32 hop = 0; hop < max_forwarding_hops; ++hop) {
            const pe::export_target found = LUCENT_TRY(look_up(base, wanted));
            std::optional<uptr> address;
            std::string next_module;
            match(
                found,
                [&](const pe::export_address& exported) { address = base + exported.rva; },
                [&](const pe::forwarder& forwarded) {
                    // Forwarders name the module without its extension.
                    next_module = forwarded.module + ".dll";
                    wanted =
                        match(forwarded.target, [](const auto& target) { return symbol{target}; });
                }
            );
            if (address) {
                return *address;
            }
            base = LUCENT_TRY(module_base(next_module));
        }
        return std::unexpected(error{.code = error_code::malformed});
    }

private:
    auto module_base(std::string_view name) -> result<uptr> {
        const std::string key = lowercase(name);
        if (const auto known = m_base_of_name.find(key); known != m_base_of_name.end()) {
            return known->second;
        }
        const std::filesystem::path path = LUCENT_TRY(library_path(name));
        result<os::remote_module> module = os::find_remote_module(*m_target, path);
        if (!module) {
            LUCENT_TRY(os::load_library_remote(*m_target, path));
            module = os::find_remote_module(*m_target, path);
        }
        const uptr base = LUCENT_TRY(std::move(module)).base;
        m_base_of_name.emplace(key, base);
        return base;
    }

    auto look_up(uptr base, const symbol& wanted) -> result<pe::export_target> {
        if (!m_exports_of_base.contains(base)) {
            m_exports_of_base.emplace(base, LUCENT_TRY(read_exports(base)));
        }
        const pe::export_table& exports = m_exports_of_base.at(base);
        return match(wanted, [&](const auto& key) { return exports.find(key); });
    }

    auto read_exports(uptr base) -> result<pe::export_table> {
        const std::vector<std::byte> header_page =
            LUCENT_TRY(os::read_remote(*m_target, {.address = base, .size = header_page_size}));
        const pe::image_view headers =
            LUCENT_TRY(pe::image_view::parse(header_page, pe::layout::mapped));
        const std::vector<std::byte> image = LUCENT_TRY(
            os::read_remote(*m_target, {.address = base, .size = headers.size_of_image()})
        );
        const pe::image_view loaded = LUCENT_TRY(pe::image_view::parse(image, pe::layout::mapped));
        return pe::export_table::from_image(loaded);
    }

    const os::process* m_target;
    std::flat_map<std::string, uptr> m_base_of_name;
    std::flat_map<uptr, pe::export_table> m_exports_of_base;
};

}

auto bind_imports(
    const os::process& target, const pe::image_view& image, std::span<std::byte> local
) -> result<void> {
    resolver exports{target};
    for (const pe::import_module& module : LUCENT_TRY(pe::imports_of(image))) {
        for (const pe::import_entry& entry : module.entries) {
            const uptr address = LUCENT_TRY(exports.resolve(module.name, symbol_of(entry.target)));
            LUCENT_TRY(write_u64(local, entry.slot_rva, address));
        }
    }
    return {};
}

}
