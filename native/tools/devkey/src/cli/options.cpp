#include "cli/options.hpp"

#include <charconv>
#include <concepts>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <print>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include <lucent/core/text.hpp>
#include <lucent/os/file.hpp>

#include "sign/dev_bundle.hpp"

namespace lucent::devkey {
namespace {

auto usage() -> error {
    std::println(
        stderr,
        "usage: devkey header <out.hpp>\n"
        "       devkey sign <module.dll> <game-module.dll> <out.bundle> <name>=<value>|@<file>...\n"
        "values are decimal, 0x-prefixed hex, or negative decimal; an address is its RVA.\n"
        "@<file> reads name=value lines from a file, as factgen writes them; # starts a comment"
    );
    return error{.code = error_code::malformed};
}

// The whole text as one number, or nothing.
template <std::integral Number>
auto parse_number(std::string_view text, i32 base) -> std::optional<Number> {
    Number value{};
    const auto [end, failure] =
        std::from_chars(std::to_address(text.begin()), std::to_address(text.end()), value, base);
    if (text.empty() || failure != std::errc{} || end != std::to_address(text.end())) {
        return std::nullopt;
    }
    return value;
}

// A negative value is stored as its two's complement, as value facts read it back.
auto parse_value(std::string_view text) -> std::optional<u64> {
    if (text.starts_with('-')) {
        return parse_number<i64>(text, 10).transform([](i64 value) {
            return static_cast<u64>(value);
        });
    }
    if (text.starts_with("0x")) {
        return parse_number<u64>(text.substr(2), 16);
    }
    return parse_number<u64>(text, 10);
}

auto parse_named_value(std::string_view text) -> std::optional<named_value> {
    const usize equals = text.find('=');
    if (equals == std::string_view::npos || equals == 0) {
        return std::nullopt;
    }
    const std::optional<u64> value = parse_value(text.substr(equals + 1));
    if (!value) {
        return std::nullopt;
    }
    return named_value{.name = std::string{text.substr(0, equals)}, .value = *value};
}

// One name=value per line; blank lines and lines starting with # are skipped.
auto read_named_values(std::string_view path) -> result<std::vector<named_value>> {
    const std::vector<std::byte> bytes = LUCENT_TRY(os::read_file(to_wide(path)));
    std::string text;
    for (const std::byte part : bytes) {
        text.push_back(static_cast<char>(part));
    }
    std::vector<named_value> values;
    for (const auto line : text | std::views::split('\n')) {
        std::string_view entry{line};
        if (entry.ends_with('\r')) {
            entry.remove_suffix(1);
        }
        if (entry.empty() || entry.starts_with('#')) {
            continue;
        }
        const std::optional<named_value> given = parse_named_value(entry);
        if (!given) {
            return std::unexpected(usage());
        }
        values.push_back(*given);
    }
    return values;
}

auto parse_sign(const std::vector<std::string>& words) -> result<command> {
    if (words.size() < 4) {
        return std::unexpected(usage());
    }
    sign_command sign{
        .request =
            dev_bundle_request{
                .module = std::filesystem::absolute(to_wide(words.at(1))),
                .game_module = std::filesystem::absolute(to_wide(words.at(2))),
                .values = {},
            },
        .bundle = std::filesystem::absolute(to_wide(words.at(3))),
    };
    for (const std::string& word : std::span{words}.subspan(4)) {
        if (word.starts_with('@')) {
            sign.request.values.append_range(LUCENT_TRY(read_named_values(word.substr(1))));
            continue;
        }
        const std::optional<named_value> given = parse_named_value(word);
        if (!given) {
            return std::unexpected(usage());
        }
        sign.request.values.push_back(*given);
    }
    return sign;
}

}

auto parse_command(std::span<const wchar_t* const> arguments) -> result<command> {
    std::vector<std::string> words;
    for (const wchar_t* const argument : arguments.subspan(1)) {
        words.push_back(to_utf8(argument));
    }
    if (words.size() == 2 && words.front() == "header") {
        return header_command{.header = std::filesystem::absolute(to_wide(words.at(1)))};
    }
    if (!words.empty() && words.front() == "sign") {
        return parse_sign(words);
    }
    return std::unexpected(usage());
}

}
