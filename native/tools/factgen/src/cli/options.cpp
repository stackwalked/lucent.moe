#include "cli/options.hpp"

#include <cstdio>
#include <expected>
#include <filesystem>
#include <print>
#include <span>
#include <string>
#include <vector>

#include <lucent/core/text.hpp>

namespace lucent::factgen {
namespace {

auto usage() -> error {
    std::println(
        stderr,
        "usage: factgen ingest --target <name>\n"
        "       factgen generate --target <name> <module.dll>\n"
        "ingest snapshots the installed game's modules into the binaries cache\n"
        "(%LOCALAPPDATA%\\lucent\\binaries); generate runs the target's finders against the\n"
        "latest snapshots and writes the values devkey signs. LUCENT_<NAME> overrides where the\n"
        "game is installed"
    );
    return error{.code = error_code::malformed};
}

}

auto parse_command(std::span<const wchar_t* const> arguments) -> result<command> {
    std::vector<std::string> words;
    for (const wchar_t* const argument : arguments.subspan(1)) {
        words.push_back(to_utf8(argument));
    }
    const bool has_target = words.size() >= 3 && words.at(1) == "--target";
    if (has_target && words.size() == 3 && words.front() == "ingest") {
        return ingest_command{.target = words.at(2)};
    }
    if (has_target && words.size() == 4 && words.front() == "generate") {
        return generate_command{
            .target = words.at(2),
            .module = std::filesystem::absolute(to_wide(words.at(3))),
        };
    }
    return std::unexpected(usage());
}

}
