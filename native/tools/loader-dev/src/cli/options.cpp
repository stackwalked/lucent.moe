#include "cli/options.hpp"

#include <cstdio>
#include <expected>
#include <filesystem>
#include <print>
#include <span>

#include <lucent/core/text.hpp>

namespace lucent::loader_dev {

auto parse_options(std::span<const wchar_t* const> arguments) -> result<options> {
    if (arguments.size() < 2 || arguments.size() > 3) {
        std::println(stderr, "usage: loader-dev <module.dll> [process name, default cs2.exe]");
        return std::unexpected(error{.code = error_code::malformed});
    }
    const std::span<const wchar_t* const> given = arguments.subspan(1);
    options chosen{.module = std::filesystem::absolute(given.front())};
    if (given.size() == 2) {
        chosen.process = to_utf8(given.back());
    }
    return chosen;
}

}
