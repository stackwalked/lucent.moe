#include "cli/options.hpp"

#include <cstdio>
#include <expected>
#include <filesystem>
#include <print>
#include <span>
#include <string>
#include <vector>

#include <lucent/core/text.hpp>

namespace lucent::facts {
namespace {

auto usage() -> error {
    std::println(
        stderr,
        "usage: facts ingest --target <name> <module.dll>\n"
        "       facts generate --target <name> <module.dll>\n"
        "       facts update-day --target <name> <module.dll>\n"
        "       facts latency\n"
        "       facts manifest --target <name> <module.dll> <out>\n"
        "       facts check --target <name> <module.dll>\n"
        "ingest snapshots the installed game's modules that the module's facts name into the\n"
        "binaries cache (%LOCALAPPDATA%\\lucent\\binaries); generate runs the target's finders\n"
        "against the latest snapshots and writes the values devkey signs, with the changes from\n"
        "the set before; update-day runs both and stops before sign-off; each step's start, end\n"
        "and outcome per module go to update-day.jsonl in the cache, which latency reports;\n"
        "manifest writes the module's release manifest, its facts and capabilities, for the\n"
        "server; check fails when the module's image holds a fact name (a release build runs it\n"
        "after linking). LUCENT_<NAME> overrides where the game is installed"
    );
    return error{.code = error_code::malformed};
}

auto path_of(const std::string& word) -> std::filesystem::path {
    return std::filesystem::absolute(to_wide(word));
}

}

auto parse_command(std::span<const wchar_t* const> arguments) -> result<command> {
    std::vector<std::string> words;
    for (const wchar_t* const argument : arguments.subspan(1)) {
        words.push_back(to_utf8(argument));
    }
    if (words.size() == 1 && words.front() == "latency") {
        return latency_command{};
    }
    const bool has_target = words.size() >= 3 && words.at(1) == "--target";
    if (!has_target) {
        return std::unexpected(usage());
    }
    const std::string& verb = words.front();
    if (words.size() == 4 && verb == "ingest") {
        return ingest_command{.target = words.at(2), .module = path_of(words.at(3))};
    }
    if (words.size() == 4 && verb == "generate") {
        return generate_command{.target = words.at(2), .module = path_of(words.at(3))};
    }
    if (words.size() == 4 && verb == "update-day") {
        return update_day_command{.target = words.at(2), .module = path_of(words.at(3))};
    }
    if (words.size() == 4 && verb == "check") {
        return check_command{.target = words.at(2), .module = path_of(words.at(3))};
    }
    if (words.size() == 5 && verb == "manifest") {
        return manifest_command{
            .target = words.at(2),
            .module = path_of(words.at(3)),
            .out = path_of(words.at(4)),
        };
    }
    return std::unexpected(usage());
}

}
