#include "app/options.hpp"

#include <cstdio>
#include <expected>
#include <iterator>
#include <optional>
#include <print>
#include <span>
#include <string_view>

#include <lucent/core/text.hpp>
#include <lucent/wire/ids.hpp>

namespace lucent::loader {
namespace {

auto usage() -> error {
    std::println(
        stderr, "usage: lucent-loader [product, default cs2] [--channel stable|alpha|debug]"
    );
    return error{.code = error_code::malformed};
}

auto channel_named(std::wstring_view name) -> std::optional<wire::channel> {
    if (name == L"stable") {
        return wire::channel::stable;
    }
    if (name == L"alpha") {
        return wire::channel::alpha;
    }
    if (name == L"debug") {
        return wire::channel::debug;
    }
    return std::nullopt;
}

}

auto parse_options(std::span<const wchar_t* const> arguments) -> result<options> {
    options chosen;
    bool has_product = false;
    const std::span<const wchar_t* const> given = arguments.subspan(1);
    for (auto at = given.begin(); at != given.end(); ++at) {
        const std::wstring_view argument{*at};
        if (argument == L"--channel") {
            if (std::next(at) == given.end()) {
                return std::unexpected(usage());
            }
            ++at;
            chosen.chosen = channel_named(*at);
            if (!chosen.chosen) {
                return std::unexpected(usage());
            }
        } else if (!has_product && !argument.starts_with(L"--")) {
            chosen.product = to_utf8(argument);
            has_product = true;
        } else {
            return std::unexpected(usage());
        }
    }
    return chosen;
}

}
