#include <algorithm>
#include <cstddef>
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

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>

#include "cache/binaries.hpp"
#include "cli/options.hpp"
#include "generate/generate.hpp"
#include "generate/manifest.hpp"
#include "install/steam.hpp"
#include "targets/linked.hpp"

namespace lucent::facts {
namespace {

auto target_named(std::string_view name) -> result<finder::target> {
    std::vector<finder::target> targets = linked_targets();
    const auto found = std::ranges::find(targets, name, &finder::target::name);
    if (found == targets.end()) {
        std::string known;
        for (const finder::target& each : targets) {
            known += known.empty() ? "" : ", ";
            known += each.name;
        }
        std::println(stderr, "facts: no target {}; this build links {}", name, known);
        return std::unexpected(error{.code = error_code::not_found});
    }
    return std::move(*found);
}

// The game modules the target's facts name, and no others.
auto modules_searched(const finder::target& target) -> std::vector<kit::game_module> {
    std::vector<kit::game_module> modules;
    for (const kit::game_module& game : target.modules) {
        const bool is_named =
            std::ranges::contains(target.searches, game.index, &finder::fact_search::module);
        if (is_named) {
            modules.push_back(game);
        }
    }
    return modules;
}

// Each command answers how many facts it left unresolved.
auto run(const ingest_command& chosen) -> result<isize> {
    const finder::target target = LUCENT_TRY(target_named(chosen.target));
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
    const finder::target target = LUCENT_TRY(target_named(chosen.target));
    const generation made = LUCENT_TRY(generate(chosen.module, target));
    std::println(
        "{} fact(s) resolved, {} failed; {} core capabilities uncovered",
        made.resolved,
        made.failed,
        made.uncovered_core
    );
    return made.failed + made.uncovered_core;
}

auto level_name(bundle::capability_level level) -> std::string_view {
    switch (level) {
    case bundle::capability_level::optional:
        return "optional";
    case bundle::capability_level::core:
        return "core";
    }
    LUCENT_UNREACHABLE();
}

// Writes the manifest, then reads back what was written, so what it prints is what the file says.
auto run(const manifest_command& chosen) -> result<isize> {
    const finder::target target = LUCENT_TRY(target_named(chosen.target));
    const module_manifest linked = LUCENT_TRY(manifest_of(chosen.module));
    const bundle::release_manifest made = LUCENT_TRY(release_manifest_of(linked, game_of(target)));
    LUCENT_TRY(os::write_file(chosen.out, bundle::encode_release_manifest(made)));
    const std::vector<std::byte> written = LUCENT_TRY(os::read_file(chosen.out));
    const bundle::release_manifest stored = LUCENT_TRY(bundle::decode_release_manifest(written));
    std::println("{}: {} bytes", chosen.out.string(), written.size());
    std::println(
        "  game {}, manifest digest {}", stored.game, hex_of(bundle::manifest_digest(stored))
    );
    std::println("  {} fact(s), {} capabilities", stored.facts.size(), stored.capabilities.size());
    for (const bundle::manifest_capability& capability : stored.capabilities) {
        std::string members;
        for (const u64 member : capability.members) {
            members += members.empty() ? "" : ", ";
            members += fact_name(member, target.searches);
        }
        std::println(
            "  capability {:#018x} {:<8} {}", capability.key, level_name(capability.level), members
        );
    }
    return 0;
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
    const lucent::result<lucent::facts::command> chosen = lucent::facts::parse_command(arguments);
    if (!chosen) {
        return 2;
    }
    const lucent::result<lucent::isize> ran = lucent::match(
        *chosen,
        [](const lucent::facts::ingest_command& command) { return lucent::facts::run(command); },
        [](const lucent::facts::generate_command& command) { return lucent::facts::run(command); },
        [](const lucent::facts::manifest_command& command) { return lucent::facts::run(command); }
    );
    if (!ran) {
        std::println(
            stderr,
            "facts: failed with error code {} (system code {})",
            std::to_underlying(ran.error().code),
            ran.error().system_code
        );
        return 1;
    }
    return *ran == 0 ? 0 : 1;
}
