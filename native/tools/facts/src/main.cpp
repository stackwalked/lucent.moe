#include <algorithm>
#include <chrono>
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
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>

#include "cache/binaries.hpp"
#include "check/names.hpp"
#include "cli/options.hpp"
#include "generate/generate.hpp"
#include "generate/manifest.hpp"
#include "install/steam.hpp"
#include "latency/step_log.hpp"
#include "targets/linked.hpp"
#include "targets/named_modules.hpp"

namespace lucent::facts {
namespace {

// The real wall clock, read only here and handed to every step that records time. Through
// file_clock, whose epoch the STL converts exactly, since the dialect keeps system_clock::now out
// of the code that takes a clock. A closure, since a function_ref binds to callable objects.
constexpr auto wall_now = [] -> wall_time {
    return std::chrono::floor<std::chrono::milliseconds>(
        std::chrono::clock_cast<std::chrono::system_clock>(std::chrono::file_clock::now())
    );
};

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

// What every update-day step works from.
struct pipeline {
    binaries_cache cache;
    finder::target target;
    std::filesystem::path module;
};

auto pipeline_of(std::string_view target, const std::filesystem::path& module) -> result<pipeline> {
    return pipeline{
        .cache = LUCENT_TRY(user_binaries_cache()),
        .target = LUCENT_TRY(target_named(target)),
        .module = module,
    };
}

// The game module's install label and file, as one ingest step sees them.
struct install_module {
    game_install install;
    std::string label;
    kit::game_module game;
};

auto ingest_one(const pipeline& run, const install_module& source) -> result<ingested> {
    const module_source file{
        .file =
            LUCENT_TRY(module_path(source.install, run.target.module_directory, source.game.name)),
        .label = source.label,
    };
    return ingest(run.cache, file, source.game.name);
}

auto ingest_step(const install_module& source, const result<ingested>& made) -> step_record {
    if (!made) {
        return step_record{
            .module = std::string{source.game.name},
            .build = "unknown",
            .step = pipeline_step::ingest,
            .outcome = step_outcome::failed,
            .start = {},
            .end = {},
            .detail = std::format("error code {}", std::to_underlying(made.error().code)),
        };
    }
    return step_record{
        .module = std::string{source.game.name},
        .build = build_name(made->taken.build),
        .step = pipeline_step::ingest,
        .outcome = made->is_new ? step_outcome::new_build : step_outcome::cached,
        .start = {},
        .end = {},
        .detail = source.label,
    };
}

// Snapshots each game module the built module's facts name; answers how many failed.
auto ingest_all(const pipeline& run, stdx::function_ref<wall_time()> now) -> result<isize> {
    const module_manifest linked = LUCENT_TRY(manifest_of(run.module));
    const game_install install = LUCENT_TRY(find_install(run.target.name, run.target.steam_app));
    const std::string label =
        std::format("Steam app {} build {}", run.target.steam_app, install.build_id);
    std::println("{} at {} ({})", run.target.name, install.directory.string(), label);
    const std::filesystem::path log = step_log_of(run.cache);
    isize failed = 0;
    for (const kit::game_module& game : modules_named(linked.facts, run.target.modules)) {
        const install_module source{.install = install, .label = label, .game = game};
        const wall_time start = now();
        const result<ingested> made = ingest_one(run, source);
        step_record step = ingest_step(source, made);
        step.start = start;
        step.end = now();
        LUCENT_TRY(append_step(log, step));
        if (!made) {
            ++failed;
            continue;
        }
        std::println(
            "  {} TimeDateStamp {:#010x} SizeOfImage {:#x}: {} {}",
            game.name,
            made->taken.build.time_date_stamp,
            made->taken.build.size_of_image,
            made->is_new ? "snapshot" : "already cached at",
            made->taken.file.string()
        );
    }
    return failed;
}

// Generates every game module's set; answers how many facts and core capabilities it left
// unresolved.
auto generate_all(const pipeline& run, stdx::function_ref<wall_time()> now) -> result<isize> {
    const generation made =
        LUCENT_TRY(generate({.cache = run.cache, .module = run.module}, run.target, now));
    const std::filesystem::path log = step_log_of(run.cache);
    for (const step_record& step : made.steps) {
        LUCENT_TRY(append_step(log, step));
    }
    std::println(
        "{} fact(s) resolved, {} failed; {} core capabilities uncovered",
        made.resolved,
        made.failed,
        made.uncovered_core
    );
    return made.failed + made.uncovered_core;
}

auto print_latency(const binaries_cache& cache) -> void {
    const std::vector<step_record> records = read_steps(step_log_of(cache));
    std::print("{}", describe(latest_runs(records)));
}

// Each command answers how many things it left undone: facts unresolved, modules not ingested.
auto run(const ingest_command& chosen) -> result<isize> {
    const pipeline run = LUCENT_TRY(pipeline_of(chosen.target, chosen.module));
    return ingest_all(run, wall_now);
}

auto run(const generate_command& chosen) -> result<isize> {
    const pipeline run = LUCENT_TRY(pipeline_of(chosen.target, chosen.module));
    return generate_all(run, wall_now);
}

// Everything an agent may run before sign-off. Signing with the facts key and publishing are a
// person's, so the pipeline ends by saying what they run next.
auto run(const update_day_command& chosen) -> result<isize> {
    const pipeline run = LUCENT_TRY(pipeline_of(chosen.target, chosen.module));
    std::println("ingest");
    const isize missed = LUCENT_TRY(ingest_all(run, wall_now));
    if (missed != 0) {
        std::println(stderr, "facts: {} module(s) not ingested; not generating", missed);
        return missed;
    }
    std::println("\ngenerate");
    const isize unresolved = LUCENT_TRY(generate_all(run, wall_now));
    std::println("\nlatency");
    print_latency(run.cache);
    std::println(
        "\nstopped before sign-off. A person reviews each module's changes.txt, then signs\n"
        "facts.txt with the line printed under it (in dev: devkey, from\n"
        ".moon/cache/cmake/dev/tools/devkey/devkey.exe); a release set is signed with the facts\n"
        "key and published by hand"
    );
    return unresolved;
}

auto run(const latency_command& /*unused*/) -> result<isize> {
    print_latency(LUCENT_TRY(user_binaries_cache()));
    return 0;
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
    const bundle::release_manifest_v3 made = LUCENT_TRY(release_manifest_of(linked, target));
    LUCENT_TRY(os::write_file(chosen.out, bundle::encode_release_manifest_v3(made)));
    const std::vector<std::byte> written = LUCENT_TRY(os::read_file(chosen.out));
    const bundle::release_manifest_v3 stored =
        LUCENT_TRY(bundle::decode_release_manifest_v3(written));
    std::println("{}: {} bytes", chosen.out.string(), written.size());
    std::println(
        "  product {}, manifest digest {}", stored.product, hex_of(bundle::manifest_digest(stored))
    );
    std::println(
        "  {} fact(s), {} capabilities, {} feature(s)",
        stored.facts.size(),
        stored.capabilities.size(),
        stored.features.size()
    );
    for (const bundle::manifest_feature& feature : stored.features) {
        std::println("  feature {:#018x} {}", feature.key, feature.tag);
    }
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

auto run(const check_command& chosen) -> result<isize> {
    const finder::target target = LUCENT_TRY(target_named(chosen.target));
    const isize findings = LUCENT_TRY(count_named_leaks(chosen.module, target));
    if (findings != 0) {
        std::println(
            stderr,
            "facts: {} fails the release name check with {} finding(s)",
            chosen.module.string(),
            findings
        );
    }
    return findings;
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
        [](const lucent::facts::update_day_command& command) {
            return lucent::facts::run(command);
        },
        [](const lucent::facts::latency_command& command) { return lucent::facts::run(command); },
        [](const lucent::facts::manifest_command& command) { return lucent::facts::run(command); },
        [](const lucent::facts::check_command& command) { return lucent::facts::run(command); }
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
