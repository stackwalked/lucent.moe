#include "install/steam.hpp"

#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <optional>
#include <print>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/text.hpp>
#include <lucent/os/file.hpp>

namespace lucent::factgen {
namespace {

// build: Steam client, 2026-11 (libraryfolders.vdf and appmanifest_<app>.acf as KeyValues text)
// found: the files on this machine; Steam writes `"key"<tabs>"value"`, backslashes doubled
// breaks: the install isn't found; set LUCENT_<TARGET> to the game's folder instead
constexpr std::string_view steam_default = "C:\\Program Files (x86)\\Steam";

auto text_of(const std::filesystem::path& path) -> std::optional<std::string> {
    const result<std::vector<std::byte>> bytes = os::read_file(path);
    if (!bytes) {
        return std::nullopt;
    }
    std::string text;
    text.reserve(bytes->size());
    for (const std::byte part : *bytes) {
        text.push_back(static_cast<char>(part));
    }
    return text;
}

auto environment(const wchar_t* name) -> std::optional<std::wstring> {
    const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (size == 0) {
        return std::nullopt;
    }
    std::wstring value(size, L'\0');
    const DWORD written = GetEnvironmentVariableW(name, value.data(), size);
    if (written == 0 || written >= size) {
        return std::nullopt;
    }
    value.resize(written);
    return value;
}

// Valve's KeyValues text, as Steam's .vdf and .acf files hold it.
struct key_values {
    std::string_view text;
};

// The quoted value after each `"key"`, unescaped.
auto values_of(key_values file, std::string_view key) -> std::vector<std::string> {
    const std::string_view text = file.text;
    const std::string quoted_key = "\"" + std::string{key} + "\"";
    std::vector<std::string> values;
    usize found_at = text.find(quoted_key);
    while (found_at != std::string_view::npos) {
        usize cursor = text.find('"', found_at + quoted_key.size());
        std::string value;
        bool is_closed = false;
        for (++cursor; cursor < text.size(); ++cursor) {
            const char letter = text.at(cursor);
            if (letter == '"') {
                is_closed = true;
                break;
            }
            if (letter == '\\' && cursor + 1 < text.size()) {
                ++cursor;
            }
            value.push_back(text.at(cursor));
        }
        if (is_closed) {
            values.push_back(value);
        }
        found_at = text.find(quoted_key, cursor);
    }
    return values;
}

auto first_value(key_values file, std::string_view key) -> std::string {
    const std::vector<std::string> values = values_of(file, key);
    return values.empty() ? std::string{} : values.front();
}

auto install_from(const std::filesystem::path& library, u32 app) -> std::optional<game_install> {
    const std::filesystem::path apps = library / L"steamapps";
    const std::optional<std::string> manifest =
        text_of(apps / std::format(L"appmanifest_{}.acf", app));
    if (!manifest) {
        return std::nullopt;
    }
    const std::string folder = first_value({.text = *manifest}, "installdir");
    if (folder.empty()) {
        return std::nullopt;
    }
    const std::filesystem::path directory = apps / L"common" / to_wide(folder);
    return game_install{
        .directory = directory,
        .build_id = first_value({.text = *manifest}, "buildid"),
    };
}

}

namespace {

auto override_variable(std::string_view target) -> std::string {
    std::string name = "LUCENT_";
    for (const char letter : target) {
        name.push_back(
            letter >= 'a' && letter <= 'z' ? static_cast<char>(letter - 'a' + 'A') : letter
        );
    }
    return name;
}

}

auto find_install(std::string_view target, u32 app) -> result<game_install> {
    const std::string variable = override_variable(target);
    if (const std::optional<std::wstring> given = environment(to_wide(variable).c_str())) {
        return game_install{.directory = std::filesystem::path{*given}, .build_id = {}};
    }
    const std::filesystem::path steam{to_wide(steam_default)};
    std::vector<std::filesystem::path> libraries{steam};
    if (const std::optional<std::string> folders =
            text_of(steam / L"steamapps" / L"libraryfolders.vdf")) {
        for (const std::string& path : values_of({.text = *folders}, "path")) {
            libraries.emplace_back(to_wide(path));
        }
    }
    for (const std::filesystem::path& library : libraries) {
        if (std::optional<game_install> found = install_from(library, app)) {
            return *std::move(found);
        }
    }
    std::println(
        stderr, "factgen: no Steam library holds app {}; set {} to its folder", app, variable
    );
    return std::unexpected(error{.code = error_code::not_found});
}

auto module_path(const game_install& install, std::string_view directory, std::string_view name)
    -> result<std::filesystem::path> {
    std::filesystem::path path = install.directory / to_wide(directory) / to_wide(name);
    std::error_code failure;
    if (!std::filesystem::is_regular_file(path, failure)) {
        std::println(stderr, "factgen: no {} at {}", name, path.string());
        return std::unexpected(error{.code = error_code::not_found});
    }
    return path;
}

}
