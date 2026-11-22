#include "cli/options.hpp"

#include <charconv>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <lucent/core/text.hpp>
#include <lucent/wire/ids.hpp>

namespace lucent::codekey {
namespace {

auto usage() -> error {
    std::println(
        stderr,
        "usage: codekey create <key file>\n"
        "       codekey public <key file>\n"
        "       codekey sign-module <key file> <out.seal> <product> <channel> <number> "
        "<container> <manifest>\n"
        "       codekey sign-loader <key file> <out.seal> <number> <release> "
        "<boot_info version> <loader.exe> <host.exe>\n"
        "channels: stable, alpha, debug; the loader has none. a release is 32 hex digits. the "
        "passphrase is asked for "
        "on the console, or read as one line from standard input when that is a pipe"
    );
    return error{.code = error_code::malformed};
}

// Arguments arrive as UTF-16 and are held as UTF-8; a path goes back to UTF-16, never through
// the ANSI code page std::filesystem would use for a narrow string.
auto path_of(const std::string& text) -> std::filesystem::path {
    return std::filesystem::path{to_wide(text)};
}

auto parse_channel(std::string_view text) -> std::optional<wire::channel> {
    if (text == "stable") {
        return wire::channel::stable;
    }
    if (text == "alpha") {
        return wire::channel::alpha;
    }
    if (text == "debug") {
        return wire::channel::debug;
    }
    return std::nullopt;
}

auto parse_u64(std::string_view text) -> std::optional<u64> {
    u64 value = 0;
    const auto [end, failure] =
        std::from_chars(std::to_address(text.begin()), std::to_address(text.end()), value, 10);
    if (text.empty() || failure != std::errc{} || end != std::to_address(text.end())) {
        return std::nullopt;
    }
    return value;
}

auto parse_release(std::string_view text) -> std::optional<wire::release_id> {
    if (text.size() != 2 * wire::id_size) {
        return std::nullopt;
    }
    wire::release_id release;
    for (usize index = 0; index < wire::id_size; ++index) {
        u8 value = 0;
        const std::string_view pair = text.substr(2 * index, 2);
        const auto [end, failure] =
            std::from_chars(std::to_address(pair.begin()), std::to_address(pair.end()), value, 16);
        if (failure != std::errc{} || end != std::to_address(pair.end())) {
            return std::nullopt;
        }
        release.bytes.at(index) = static_cast<std::byte>(value);
    }
    return release;
}

auto sign_module(const std::vector<std::string>& given) -> std::optional<command> {
    if (given.size() != 8) {
        return std::nullopt;
    }
    const std::optional<wire::channel> chosen = parse_channel(given.at(4));
    const std::optional<u64> number = parse_u64(given.at(5));
    if (!chosen || !number) {
        return std::nullopt;
    }
    return sign_module_command{
        .key_file = path_of(given.at(1)),
        .seal = path_of(given.at(2)),
        .product = given.at(3),
        .chosen = *chosen,
        .number = *number,
        .container = path_of(given.at(6)),
        .manifest = path_of(given.at(7)),
    };
}

auto sign_loader(const std::vector<std::string>& given) -> std::optional<command> {
    if (given.size() != 8) {
        return std::nullopt;
    }
    const std::optional<u64> number = parse_u64(given.at(3));
    const std::optional<wire::release_id> release = parse_release(given.at(4));
    const std::optional<u64> boot_info_version = parse_u64(given.at(5));
    if (!number || !release || !boot_info_version || *boot_info_version > 0xffff'ffffU) {
        return std::nullopt;
    }
    return sign_loader_command{
        .key_file = path_of(given.at(1)),
        .seal = path_of(given.at(2)),
        .number = *number,
        .release = *release,
        .boot_info_version = static_cast<u32>(*boot_info_version),
        .loader = path_of(given.at(6)),
        .host = path_of(given.at(7)),
    };
}

auto parse(const std::vector<std::string>& given) -> std::optional<command> {
    if (given.empty()) {
        return std::nullopt;
    }
    const std::string_view verb = given.front();
    if (verb == "create" && given.size() == 2) {
        return create_command{.key_file = path_of(given.at(1))};
    }
    if (verb == "public" && given.size() == 2) {
        return public_command{.key_file = path_of(given.at(1))};
    }
    if (verb == "sign-module") {
        return sign_module(given);
    }
    if (verb == "sign-loader") {
        return sign_loader(given);
    }
    return std::nullopt;
}

}

auto parse_command(std::span<const wchar_t* const> arguments) -> result<command> {
    std::vector<std::string> given;
    for (const wchar_t* const argument : arguments.subspan(1)) {
        given.push_back(to_utf8(argument));
    }
    std::optional<command> parsed = parse(given);
    if (!parsed) {
        return std::unexpected(usage());
    }
    return std::move(*parsed);
}

}
