#include "cli/options.hpp"

#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <optional>
#include <print>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/wire/ids.hpp>

namespace lucent::pack {
namespace {

auto usage() -> error {
    std::println(
        stderr,
        "usage: pack <module.dll> <out.container> --release <32 hex digits>\n"
        "writes the module's container; the release build runs it after linking each module.\n"
        "a module without a lucent_boot export is refused"
    );
    return error{.code = error_code::malformed};
}

auto nibble(wchar_t digit) -> std::optional<u8> {
    if (digit >= L'0' && digit <= L'9') {
        return static_cast<u8>(digit - L'0');
    }
    if (digit >= L'a' && digit <= L'f') {
        return static_cast<u8>(digit - L'a' + 10);
    }
    return std::nullopt;
}

auto parse_release(std::wstring_view text) -> std::optional<wire::release_id> {
    if (text.size() != 2 * wire::id_size) {
        return std::nullopt;
    }
    wire::release_id release;
    for (usize index = 0; index < wire::id_size; ++index) {
        const std::optional<u8> high = nibble(text.at(2 * index));
        const std::optional<u8> low = nibble(text.at((2 * index) + 1));
        if (!high || !low) {
            return std::nullopt;
        }
        release.bytes.at(index) = static_cast<std::byte>((u32{*high} << 4U) | u32{*low});
    }
    return release;
}

}

auto parse_options(std::span<const wchar_t* const> arguments) -> result<options> {
    const std::vector<std::wstring_view> given{arguments.begin(), arguments.end()};
    if (given.size() != 5 || given.at(3) != L"--release") {
        return std::unexpected(usage());
    }
    const std::optional<wire::release_id> release = parse_release(given.at(4));
    if (!release) {
        return std::unexpected(usage());
    }
    return options{
        .module = std::filesystem::path{given.at(1)},
        .container = std::filesystem::path{given.at(2)},
        .release = *release,
    };
}

}
