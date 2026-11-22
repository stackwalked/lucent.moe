#pragma once

#include <optional>
#include <span>
#include <string>

#include <lucent/wire/ids.hpp>

namespace lucent::loader {

struct options {
    // A product id; the only game product is cs2.
    std::string product = "cs2";
    // Kept for next time once given; the saved one, else stable, when not.
    std::optional<wire::channel> chosen;
};

// `lucent-loader [product] [--channel stable|alpha|debug]`. Prints the usage line to stderr when
// the arguments don't fit it.
auto parse_options(std::span<const wchar_t* const> arguments) -> result<options>;

}
