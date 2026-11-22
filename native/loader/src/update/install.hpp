#pragma once

#include <cstddef>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <variant>

#include <lucent/wire/refusal.hpp>
#include <lucent/wire/release_seal.hpp>

#include "api/server.hpp"

// Installed releases live side by side under <root>/releases/<seal number>/, each with its loader,
// host and seal, and the Start menu shortcut names the one in use. An update writes the new
// directory whole and starts it; the shortcut moves only once the new loader runs and finds itself
// current, so a release that won't start leaves the one before it in place as the way back.

namespace lucent::loader {

inline constexpr std::string_view loader_file = "lucent-loader.exe";
inline constexpr std::string_view host_file = "lucent-host.exe";
inline constexpr std::string_view seal_file = "seal.bin";

auto release_directory(const std::filesystem::path& root, u64 number) -> std::filesystem::path;

// The seal number of the release directory this executable runs from; nothing when it runs from
// anywhere else (a fresh download, a dev build).
auto running_release(const std::filesystem::path& root) -> std::optional<u64>;

struct installed {
    std::filesystem::path loader;
};

using install_outcome = std::variant<installed, wire::refusal>;

// Downloads both artifacts the seal names, checks each against its digest, and writes the
// release's directory. A directory half written by an earlier try is replaced.
auto install_release(
    server& api,
    std::string_view access_token,
    const std::filesystem::path& root,
    const wire::release_seal& seal,
    std::span<const std::byte> seal_bytes
) -> result<install_outcome>;

// Points the Start menu's Lucent shortcut at this loader.
auto point_shortcut(const std::filesystem::path& loader) -> result<void>;

// Starts that loader with this one's arguments, without waiting for it.
auto hand_over(const std::filesystem::path& loader) -> result<void>;

// Removes every release directory but the current one and the newest below it, the way back.
auto prune_releases(const std::filesystem::path& root, u64 current) -> void;

}
