#include "image/system_modules.hpp"

#include <array>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>

#include "image/refusal.hpp"

namespace lucent::pack {
namespace {

// Real chains are one hop (kernel32 to ntdll), as in manualmap's resolver; the bound stops a
// cycle.
constexpr u32 max_forwarding_hops = 8;

// build: Windows 11 24H2 (26100), the API set schema in ntdll's ApiSetMap
// found: kernel32!SetThreadDescription forwards to api-ms-win-core-processthreads-l1-1-3, which
//        the schema maps to kernel32 for every importer but kernel32 itself (its exception entry
//        names kernelbase); LoadLibraryExW resolves it as an ordinary importer would, back to
//        kernel32, so a chain from kernel32 into an API set would never leave it
// breaks: such an import is refused as forwarded too far (pack) or fails to map (manualmap)
constexpr std::string_view api_set_host = "kernelbase.dll";

// Enough to hold any module's headers.
constexpr usize header_page_size = 0x1000;

auto lowercase(std::string_view text) -> std::string {
    const auto lower = [](char character) {
        return character >= 'A' && character <= 'Z' ? static_cast<char>(character - 'A' + 'a')
                                                    : character;
    };
    return text | std::views::transform(lower) | std::ranges::to<std::string>();
}

auto system_directory() -> std::filesystem::path {
    std::array<wchar_t, MAX_PATH> buffer{};
    const UINT length = GetSystemDirectoryW(buffer.data(), narrow<UINT>(buffer.size()));
    return std::wstring{buffer.data(), length};
}

auto is_same_directory(const std::filesystem::path& left, const std::filesystem::path& right)
    -> bool {
    return lowercase(to_utf8(left.wstring())) == lowercase(to_utf8(right.wstring()));
}

// The module's image in this process, where LoadLibraryExW mapped it.
auto image_of(const void* handle) -> result<pe::image_view> {
    const auto* const base = static_cast<const std::byte*>(handle);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // a mapped image's own size
    const pe::image_view headers =
        LUCENT_TRY(pe::image_view::parse(std::span{base, header_page_size}, pe::layout::mapped));
    return pe::image_view::parse(std::span{base, headers.size_of_image()}, pe::layout::mapped);
#pragma clang diagnostic pop
}

auto unresolved(std::string_view module, std::string_view function, std::string_view why)
    -> refusal {
    return refusal{
        .reason = refusal_reason::import_unresolved,
        .detail = std::format("{}!{} ({})", module, function, why),
    };
}

}

system_modules::~system_modules() {
    for (const mapped_module& module : m_by_name.values()) {
        FreeLibrary(static_cast<HMODULE>(module.handle));
    }
}

auto system_modules::map(std::string_view name) -> pack_result<mapped_module> {
    const std::string key = lowercase(name);
    if (const auto known = m_by_name.find(key); known != m_by_name.end()) {
        return known->second;
    }
    const std::wstring wide = to_wide(name);
    // Mapped as an image without running it or loading what it imports.
    const HMODULE handle = LoadLibraryExW(wide.c_str(), nullptr, DONT_RESOLVE_DLL_REFERENCES);
    if (handle == nullptr) {
        return std::unexpected(
            refusal{
                .reason = refusal_reason::import_unresolved,
                .detail = std::format("{} doesn't load on this machine", name),
            }
        );
    }
    std::wstring path(UNICODE_STRING_MAX_CHARS, L'\0');
    const DWORD size = GetModuleFileNameW(handle, path.data(), narrow<DWORD>(path.size()));
    path.resize(size);
    mapped_module mapped{.handle = handle, .path = std::filesystem::path{std::move(path)}};
    m_by_name.emplace(key, mapped);
    return mapped;
}

auto system_modules::resolve_module(std::string_view name) -> pack_result<std::string> {
    const mapped_module module = LUCENT_TRY(map(name));
    if (!is_same_directory(module.path.parent_path(), system_directory())) {
        return std::unexpected(
            refusal{
                .reason = refusal_reason::import_outside_system32,
                .detail = std::format("{} resolves to {}", name, to_utf8(module.path.wstring())),
            }
        );
    }
    return lowercase(to_utf8(module.path.filename().wstring()));
}

auto system_modules::check_export(std::string_view module, std::string_view function)
    -> pack_result<void> {
    std::string current_module{module};
    std::variant<std::string, pe::export_ordinal> wanted{std::string{function}};
    for (u32 hop = 0; hop < max_forwarding_hops; ++hop) {
        const mapped_module mapped = LUCENT_TRY(map(current_module));
        const result<pe::image_view> image = image_of(mapped.handle);
        if (!image) {
            return std::unexpected(
                unresolved(module, function, std::format("{} isn't an image", current_module))
            );
        }
        const result<pe::export_table> exports = pe::export_table::from_image(*image);
        if (!exports) {
            return std::unexpected(
                unresolved(module, function, std::format("{} has no export table", current_module))
            );
        }
        const result<pe::export_target> found =
            match(wanted, [&](const auto& key) { return exports->find(key); });
        if (!found) {
            return std::unexpected(
                unresolved(module, function, std::format("{} doesn't export it", current_module))
            );
        }
        const std::optional<pe::forwarder> next = match(
            *found,
            [](const pe::export_address&) -> std::optional<pe::forwarder> { return std::nullopt; },
            [](const pe::forwarder& forwarded) -> std::optional<pe::forwarder> { return forwarded; }
        );
        if (!next) {
            return {};
        }
        // Forwarders name the module without its extension.
        const std::string forwarded_to = next->module + ".dll";
        const mapped_module target = LUCENT_TRY(map(forwarded_to));
        current_module = target.handle == mapped.handle ? std::string{api_set_host} : forwarded_to;
        wanted = next->target;
    }
    return std::unexpected(unresolved(module, function, "forwarded too far"));
}

}
