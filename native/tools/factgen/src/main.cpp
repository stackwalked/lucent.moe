#include <algorithm>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/finders/fact_search.hpp>
#include <lucent/finders/target.hpp>
#include <lucent/kit/game_module.hpp>

#include "cache/binaries.hpp"
#include "cli/options.hpp"
#include "generate/generate.hpp"
#include "install/steam.hpp"
#include "targets/linked.hpp"

namespace lucent::factgen {
namespace {

auto target_named(std::string_view name) -> result<finders::target> {
    std::vector<finders::target> targets = linked_targets();
    const auto found = std::ranges::find(targets, name, &finders::target::name);
    if (found == targets.end()) {
        std::string known;
        for (const finders::target& each : targets) {
            known += known.empty() ? "" : ", ";
            known += each.name;
        }
        std::println(stderr, "factgen: no target {}; this build links {}", name, known);
        return std::unexpected(error{.code = error_code::not_found});
    }
    return std::move(*found);
}

// The game modules the target's facts name, and no others.
auto modules_searched(const finders::target& target) -> std::vector<kit::game_module> {
    std::vector<kit::game_module> modules;
    for (const kit::game_module& game : target.modules) {
        const bool is_named =
            std::ranges::contains(target.searches, game.index, &finders::fact_search::module);
        if (is_named) {
            modules.push_back(game);
        }
    }
    return modules;
}

// Each command answers how many facts it left unresolved.
auto run(const ingest_command& chosen) -> result<isize> {
    const finders::target target = LUCENT_TRY(target_named(chosen.target));
    const game_install install = LUCENT_TRY(find_install(target.name, target.steam_app));
    const std::string label =
        std::format("Steam app {} build {}", target.steam_app, install.build_id);
    std::println("{} at {} ({})", target.name, install.directory.string(), label);
    for (const kit::game_module& game : modules_searched(target)) {
        const module_source source{
            .file = LUCENT_TRY(module_path(install, target.module_directory, game.name)),
            .label = label,
        };
        const ingested made = LUCENT_TRY(ingest(source, game.name));
        std::println(
            "  {} TimeDateStamp {:#010x} SizeOfImage {:#x}: {} {}",
            game.name,
            made.taken.build.time_date_stamp,
            made.taken.build.size_of_image,
            made.is_new ? "snapshot" : "already cached at",
            made.taken.file.string()
        );
    }
    return 0;
}

auto run(const generate_command& chosen) -> result<isize> {
    const finders::target target = LUCENT_TRY(target_named(chosen.target));
    const generation made = LUCENT_TRY(generate(chosen.module, target));
    std::println("{} fact(s) resolved, {} failed", made.resolved, made.failed);
    return made.failed;
}

}
}

// The CRT's entry signature. argv is the CRT's array of argc pointers: the one place a span is
// built from a pointer and a count, and everything after reads it through that span.
// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT calls wmain by this name and signature, as it does main.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> arguments{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    const lucent::result<lucent::factgen::command> chosen =
        lucent::factgen::parse_command(arguments);
    if (!chosen) {
        return 2;
    }
    const lucent::result<lucent::isize> ran = lucent::match(
        *chosen,
        [](const lucent::factgen::ingest_command& command) {
            return lucent::factgen::run(command);
        },
        [](const lucent::factgen::generate_command& command) {
            return lucent::factgen::run(command);
        }
    );
    if (!ran) {
        std::println(
            stderr,
            "factgen: failed with error code {} (system code {})",
            std::to_underlying(ran.error().code),
            ran.error().system_code
        );
        return 1;
    }
    return *ran == 0 ? 0 : 1;
}
