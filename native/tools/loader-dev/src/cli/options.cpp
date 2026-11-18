#include "cli/options.hpp"

#include <cstdio>
#include <expected>
#include <filesystem>
#include <print>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/core/text.hpp>
#include <lucent/kit/boot_info.hpp>

namespace lucent::loader_dev {
namespace {

auto usage() -> error {
    std::println(
        stderr, "usage: loader-dev <module.dll> [process name, default cs2.exe] [--os-loader]"
    );
    return error{.code = error_code::malformed};
}

}

auto parse_options(std::span<const wchar_t* const> arguments) -> result<options> {
    options chosen;
    std::vector<std::wstring_view> positional;
    for (const wchar_t* const argument : arguments.subspan(1)) {
        const std::wstring_view given{argument};
        if (given == L"--os-loader") {
            chosen.loading = kit::image_kind::loaded;
        } else {
            positional.push_back(given);
        }
    }
    if (positional.empty() || positional.size() > 2) {
        return std::unexpected(usage());
    }
    chosen.module = std::filesystem::absolute(positional.front());
    if (positional.size() == 2) {
        chosen.process = to_utf8(positional.back());
    }
    return chosen;
}

}
