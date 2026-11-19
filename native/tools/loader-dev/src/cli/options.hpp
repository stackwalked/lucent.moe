#pragma once

#include <filesystem>
#include <optional>
#include <span>
#include <string>

#include <lucent/kit/boot_info.hpp>

namespace lucent::loader_dev {

struct options {
    std::filesystem::path module;
    std::string process = "cs2.exe";
    // Mapped, as release does; the OS loader on request, for debugging with symbols.
    kit::image_kind loading = kit::image_kind::mapped;
    // A fact bundle for boot_info (devkey sign makes one); without it every fact stays unresolved.
    std::optional<std::filesystem::path> bundle;
};

auto is_container(const options& chosen) -> bool;

// Prints the usage line to stderr when the arguments don't fit it.
auto parse_options(std::span<const wchar_t* const> arguments) -> result<options>;

}
