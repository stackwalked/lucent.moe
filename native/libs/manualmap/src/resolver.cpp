#include "resolver.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <flat_map>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
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
#include <lucent/wire/container.hpp>

namespace lucent::manualmap::detail {
namespace {

// Real chains are one hop (kernel32 to ntdll); the bound only stops a cycle.
constexpr u32 max_forwarding_hops = 8;

// Enough to hold any module's headers.
constexpr usize header_page_size = 0x1000;

// build: the PE32+ export directory layout (Microsoft's PE format documentation)
// found: IMAGE_EXPORT_DIRECTORY in winnt.h: NumberOfNames at 24, AddressOfNames at 32
// breaks: hashed imports find no export and the container fails to map
constexpr u32 number_of_names_at = 24;
constexpr u32 address_of_names_at = 32;
// More names than any system module exports; the bound stops a corrupt count.
constexpr u32 max_export_names = 0x10000;

// build: Windows 11 24H2 (26100), the API set schema in ntdll's ApiSetMap
// found: kernel32!SetThreadDescription forwards to api-ms-win-core-processthreads-l1-1-3, which
//        the schema maps to kernel32 for every importer but kernel32 itself (its exception entry
//        names kernelbase); LoadLibraryExW resolves it as an ordinary importer would, back to
//        kernel32, so a chain from kernel32 into an API set would never leave it
// breaks: such an import fails to map as malformed after max_forwarding_hops
constexpr std::string_view api_set_host = "kernelbase.dll";

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

auto read_u32_at(const pe::image_view& image, u32 rva) -> result<u32> {
    const std::span<const std::byte> bytes =
        LUCENT_TRY(image.bytes_at({.rva = rva, .size = sizeof(u32)}));
    std::array<std::byte, sizeof(u32)> raw{};
    std::ranges::copy(bytes, raw.begin());
    return std::bit_cast<u32>(raw);
}

auto export_names(const pe::image_view& image) -> result<std::vector<std::string>> {
    const std::optional<pe::directory> directory =
        image.find_directory(pe::directory_kind::exports);
    if (!directory) {
        return std::vector<std::string>{};
    }
    const u32 count = LUCENT_TRY(read_u32_at(image, directory->rva + number_of_names_at));
    const u32 table = LUCENT_TRY(read_u32_at(image, directory->rva + address_of_names_at));
    if (count > max_export_names) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::vector<std::string> names;
    names.reserve(count);
    for (u32 index = 0; index < count; ++index) {
        const u32 name = LUCENT_TRY(read_u32_at(image, table + (index * sizeof(u32))));
        names.push_back(LUCENT_TRY(image.string_at(name)));
    }
    return names;
}

// System32's DLLs by file name, lowercase: where an import the target hasn't loaded comes from.
auto system_module_names() -> std::vector<std::string> {
    std::array<wchar_t, MAX_PATH> buffer{};
    const UINT length = GetSystemDirectoryW(buffer.data(), narrow<UINT>(buffer.size()));
    std::vector<std::string> names;
    std::error_code failure;
    for (const std::filesystem::directory_entry& entry : std::filesystem::directory_iterator{
             std::filesystem::path{std::wstring{buffer.data(), length}}, failure
         }) {
        const std::filesystem::path name = entry.path().filename();
        if (lowercase(to_utf8(name.extension().wstring())) == ".dll") {
            names.push_back(lowercase(to_utf8(name.wstring())));
        }
    }
    return names;
}

}

resolver::resolver(const os::process& target, std::optional<wire::import_key> key)
    : m_target{&target}
    , m_key{key} {}

auto resolver::resolve(std::string_view module, symbol wanted) -> result<uptr> {
    uptr base = LUCENT_TRY(module_base(module));
    for (u32 hop = 0; hop < max_forwarding_hops; ++hop) {
        const module_exports* exports = LUCENT_TRY(exports_at(base));
        const pe::export_target found =
            LUCENT_TRY(match(wanted, [&](const auto& key) { return exports->table.find(key); }));
        std::optional<uptr> address;
        std::string next_module;
        match(
            found,
            [&](const pe::export_address& exported) { address = base + exported.rva; },
            [&](const pe::forwarder& forwarded) {
                // Forwarders name the module without its extension.
                next_module = forwarded.module + ".dll";
                wanted = match(forwarded.target, [](const auto& target) { return symbol{target}; });
            }
        );
        if (address) {
            return *address;
        }
        const uptr next = LUCENT_TRY(module_base(next_module));
        base = next == base ? LUCENT_TRY(module_base(api_set_host)) : next;
    }
    return std::unexpected(error{.code = error_code::malformed});
}

auto resolver::resolve_import(const wire::container_import& wanted) -> result<uptr> {
    // A resolver made without a key can't name anything by hash.
    if (!m_key) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    const wire::import_key key = *m_key;
    const std::string module = LUCENT_TRY(module_named(wanted.module_hash, key));
    const uptr base = LUCENT_TRY(module_base(module));
    const module_exports* exports = LUCENT_TRY(exports_at(base));
    const auto found = std::ranges::find_if(exports->names, [&](const std::string& name) {
        return wire::import_hash(key, name) == wanted.function_hash;
    });
    if (found == exports->names.end()) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    return resolve(module, symbol{*found});
}

auto resolver::module_base(std::string_view name) -> result<uptr> {
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

auto resolver::exports_at(uptr base) -> result<const module_exports*> {
    if (const auto known = m_exports_of_base.find(base); known != m_exports_of_base.end()) {
        return &known->second;
    }
    const std::vector<std::byte> header_page =
        LUCENT_TRY(os::read_remote(*m_target, {.address = base, .size = header_page_size}));
    const pe::image_view headers =
        LUCENT_TRY(pe::image_view::parse(header_page, pe::layout::mapped));
    const std::vector<std::byte> image =
        LUCENT_TRY(os::read_remote(*m_target, {.address = base, .size = headers.size_of_image()}));
    const pe::image_view loaded = LUCENT_TRY(pe::image_view::parse(image, pe::layout::mapped));
    module_exports exports{
        .table = LUCENT_TRY(pe::export_table::from_image(loaded)),
        .names = m_key ? LUCENT_TRY(export_names(loaded)) : std::vector<std::string>{},
    };
    const auto [placed, is_new] = m_exports_of_base.emplace(base, std::move(exports));
    return &placed->second;
}

auto resolver::module_named(u64 hash, const wire::import_key& key) -> result<std::string> {
    if (!m_module_of_hash) {
        std::flat_map<u64, std::string> names;
        for (const std::string& name : system_module_names()) {
            names.insert_or_assign(wire::import_hash(key, name), name);
        }
        // The target's own modules win: what it has loaded is what the import binds to.
        for (const os::remote_module& module : LUCENT_TRY(os::remote_modules(*m_target))) {
            const std::string name = lowercase(module.name);
            names.insert_or_assign(wire::import_hash(key, name), name);
        }
        m_module_of_hash = std::move(names);
    }
    const auto found = m_module_of_hash->find(hash);
    if (found == m_module_of_hash->end()) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    return found->second;
}

}
