#include "generate/generate.hpp"

#include <algorithm>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <optional>
#include <print>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>

#include "cache/binaries.hpp"
#include "generate/changes.hpp"
#include "generate/kind_check.hpp"
#include "generate/manifest.hpp"
#include "latency/step_log.hpp"

namespace lucent::facts {
namespace {

auto kind_name(kit::fact_kind kind) -> std::string_view {
    switch (kind) {
    case kit::fact_kind::method:
        return "method";
    case kit::fact_kind::global:
        return "global";
    case kit::fact_kind::vtable:
        return "vtable";
    case kit::fact_kind::slot:
        return "slot";
    case kit::fact_kind::field:
        return "field";
    case kit::fact_kind::value:
        return "value";
    }
    LUCENT_UNREACHABLE();
}

auto miss_name(probe::miss missed) -> std::string_view {
    switch (missed) {
    case probe::miss::none:
        return "found nothing";
    case probe::miss::ambiguous:
        return "found more than one value";
    }
    LUCENT_UNREACHABLE();
}

auto key_of(const finder::fact_search& search) -> u64 {
    return kit::fact_key_of(search.fact);
}

// A search whose fact the module links, with the kind it was declared with, and finders fit to
// resolve it.
struct covered_fact {
    finder::fact_search search;
    kit::fact_record record;
};

auto flaw_name(probe::finder_set_flaw flaw) -> std::string_view {
    switch (flaw) {
    case probe::finder_set_flaw::empty:
        return "has no finders";
    case probe::finder_set_flaw::lone_shape:
        return "rests on one finder matching a body's shape; it needs a second finder";
    case probe::finder_set_flaw::unexplained_bytes:
        return "has a byte pattern that doesn't say why it's needed";
    }
    LUCENT_UNREACHABLE();
}

auto cover_one(const finder::fact_search& search, std::span<const kit::fact_record> manifest)
    -> std::optional<covered_fact> {
    const auto record = std::ranges::find(manifest, key_of(search), &kit::fact_record::key);
    if (record == manifest.end()) {
        std::println("  error: {}: the module doesn't link it", search.fact);
        return std::nullopt;
    }
    if (record->kind != search.kind) {
        std::println(
            "  error: {}: declared a {}, searched as a {}",
            search.fact,
            kind_name(record->kind),
            kind_name(search.kind)
        );
        return std::nullopt;
    }
    if (record->module != search.module) {
        std::println(
            "  error: {}: declared in module {}, searched in module {}",
            search.fact,
            record->module,
            search.module
        );
        return std::nullopt;
    }
    if (const std::optional<probe::finder_set_flaw> flaw = probe::flaw_of(search.finders)) {
        std::println("  error: {}: {}", search.fact, flaw_name(*flaw));
        return std::nullopt;
    }
    return covered_fact{.search = search, .record = *record};
}

// Matches the searches to the manifest both ways, kind for kind; prints an error for each that
// doesn't fit and counts it.
auto coverage(
    std::span<const kit::fact_record> manifest,
    std::span<const finder::fact_search> searches,
    generation& tally
) -> std::vector<covered_fact> {
    std::vector<covered_fact> covered;
    for (const auto [index, search] : std::views::enumerate(searches)) {
        const bool is_repeated = std::ranges::any_of(
            searches.first(narrow<usize>(index)),
            [&](const finder::fact_search& earlier) { return earlier.fact == search.fact; }
        );
        if (is_repeated) {
            std::println("  error: {}: searched twice", search.fact);
            ++tally.failed;
            continue;
        }
        if (std::optional<covered_fact> fits = cover_one(search, manifest)) {
            covered.push_back(*fits);
        } else {
            ++tally.failed;
        }
    }
    for (const kit::fact_record& record : manifest) {
        if (!std::ranges::contains(searches, record.key, &key_of)) {
            std::println(
                "  error: the module links a {} fact (key {:#018x}) that no finder derives",
                kind_name(record.kind),
                record.key
            );
            ++tally.failed;
        }
    }
    return covered;
}

auto finder_names(const finder::fact_search& search, std::span<const isize> chosen) -> std::string {
    std::string names;
    for (const auto [index, each] : std::views::enumerate(search.finders)) {
        if (std::ranges::contains(chosen, index)) {
            names += names.empty() ? "" : "; ";
            names += each.name;
        }
    }
    return names;
}

struct resolution {
    // Present when the finders agree and the value passes its kind's check.
    std::optional<u64> value;
    // Finders that found nothing while the rest agreed.
    isize warnings = 0;
};

// Runs one fact's finders.
auto resolve_one(
    const covered_fact& fact, const probe::module_file& module, const probe::code_index& index
) -> resolution {
    std::vector<probe::finding> findings;
    for (const probe::finder& each : fact.search.finders) {
        findings.push_back(each.run(module, index));
    }
    const std::expected<probe::agreement, probe::disagreement> settled = probe::agree(findings);
    if (!settled) {
        std::println(
            "  error: {}: {}",
            fact.search.fact,
            settled.error() == probe::disagreement::conflict ? "its finders disagree"
                                                             : "no finder found it"
        );
        for (const auto [each, found] : std::views::zip(fact.search.finders, findings)) {
            const std::string outcome =
                found ? std::format("{:#x}", *found) : std::string{miss_name(found.error())};
            std::println("    {}: {}", each.name, outcome);
        }
        return {};
    }
    if (const std::optional<kind_flaw> flaw = kind_flaw_of(module, fact.record, settled->value)) {
        std::println("  error: {}: {:#x} is {}", fact.search.fact, settled->value, describe(*flaw));
        return {};
    }
    resolution resolved{.value = settled->value, .warnings = 0};
    std::println(
        "  {:<26} {:<7} {:#12x}  {}/{} agree: {}",
        fact.search.fact,
        kind_name(fact.record.kind),
        settled->value,
        settled->agreed.size(),
        findings.size(),
        finder_names(fact.search, settled->agreed)
    );
    for (const auto [each, found] : std::views::zip(fact.search.finders, findings)) {
        if (!found) {
            std::println(
                "  warning: {}: \"{}\" {} while the rest agreed",
                fact.search.fact,
                each.name,
                miss_name(found.error())
            );
            ++resolved.warnings;
        }
    }
    return resolved;
}

auto labels_of(const snapshot& taken) -> std::string {
    const result<std::vector<std::byte>> stored = os::read_file(taken.directory / L"label.txt");
    std::string text;
    for (const std::byte part : stored.value_or(std::vector<std::byte>{})) {
        text.push_back(part == std::byte{'\n'} ? ' ' : static_cast<char>(part));
    }
    while (text.ends_with(' ')) {
        text.pop_back();
    }
    return text;
}

auto text_in(const std::filesystem::path& path) -> std::optional<std::string> {
    const result<std::vector<std::byte>> stored = os::read_file(path);
    if (!stored) {
        return std::nullopt;
    }
    std::string text;
    for (const std::byte part : *stored) {
        text.push_back(static_cast<char>(part));
    }
    return text;
}

// The set a new one is compared against, standing in for the last published set until sets are
// published: the last set generated for the build this one replaced, so the deltas a person signs
// off on are the update's whoever reran generate since; failing that, the last set generated for
// this same build.
struct baseline {
    std::string label;
    std::string values;
};

auto baseline_of(const binaries_cache& cache, const snapshot& taken) -> std::optional<baseline> {
    if (const std::optional<std::filesystem::path> previous =
            previous_build_directory(cache, taken.module)) {
        if (std::optional<std::string> values = text_in(*previous / L"facts.txt")) {
            return baseline{
                .label = std::format(
                    "the last set generated for the previous build, {}",
                    previous->filename().string()
                ),
                .values = *std::move(values),
            };
        }
    }
    if (std::optional<std::string> values = text_in(taken.directory / L"facts.txt")) {
        return baseline{
            .label = "the last set generated for this build",
            .values = *std::move(values),
        };
    }
    return std::nullopt;
}

auto write_changes(const binaries_cache& cache, const snapshot& taken, std::string_view values)
    -> result<void> {
    const std::optional<baseline> before = baseline_of(cache, taken);
    const std::string report =
        before ? std::format(
                     "# changes against {}\n{}",
                     before->label,
                     describe(changes_between({.before = before->values, .after = values}))
                 )
               : std::string{"# no earlier set generated for this module: every value is new\n"};
    const std::filesystem::path written = taken.directory / L"changes.txt";
    LUCENT_TRY(os::write_file(written, std::as_bytes(std::span{report})));
    std::print("  {}", report.substr(2));
    std::println("  changes: {}", written.string());
    return {};
}

// What one game module's generation left, for the tally and the update-day log.
struct module_values {
    std::string build;
    isize resolved = 0;
    isize failed = 0;
    isize warnings = 0;
    std::vector<u64> resolved_keys;
};

auto generate_module(
    const generation_source& source,
    const kit::game_module& game,
    std::span<const covered_fact> facts
) -> result<module_values> {
    const snapshot taken = LUCENT_TRY(latest_snapshot(source.cache, game.name));
    const std::vector<std::byte> file = LUCENT_TRY(os::read_file(taken.file));
    const probe::module_file module = LUCENT_TRY(probe::module_file::load(file));
    const probe::code_index index = probe::code_index::build(module);
    std::println(
        "{} TimeDateStamp {:#010x} SizeOfImage {:#x} ({}), {} references indexed",
        game.name,
        taken.build.time_date_stamp,
        taken.build.size_of_image,
        labels_of(taken),
        index.size()
    );
    std::string values = std::format(
        "# facts: {} TimeDateStamp {:#010x} SizeOfImage {:#x}\n",
        game.name,
        taken.build.time_date_stamp,
        taken.build.size_of_image
    );
    module_values made{
        .build = build_name(taken.build),
        .resolved = 0,
        .failed = 0,
        .warnings = 0,
        .resolved_keys = {},
    };
    for (const covered_fact& fact : facts) {
        if (fact.search.module != game.index) {
            continue;
        }
        const resolution resolved = resolve_one(fact, module, index);
        made.warnings += resolved.warnings;
        if (resolved.value) {
            values += std::format("{}={:#x}\n", fact.search.fact, *resolved.value);
            ++made.resolved;
            made.resolved_keys.push_back(fact.record.key);
        } else {
            ++made.failed;
        }
    }
    LUCENT_TRY(write_changes(source.cache, taken, values));
    const std::filesystem::path written = taken.directory / L"facts.txt";
    LUCENT_TRY(os::write_file(written, std::as_bytes(std::span{values})));
    std::println("  values: {}", written.string());
    std::println(
        R"(  sign:   devkey sign "{}" "{}" <out.bundle> "@{}")",
        source.module.string(),
        taken.file.string(),
        written.string()
    );
    return made;
}

// The module's generate step for the update-day log, timed by the caller. A module that couldn't
// be generated has no build to name when its snapshot is what failed.
auto step_of(const kit::game_module& game, const result<module_values>& made) -> step_record {
    if (!made) {
        return step_record{
            .module = std::string{game.name},
            .build = "unknown",
            .step = pipeline_step::generate,
            .outcome = step_outcome::failed,
            .start = {},
            .end = {},
            .detail = std::format("error code {}", std::to_underlying(made.error().code)),
        };
    }
    return step_record{
        .module = std::string{game.name},
        .build = made->build,
        .step = pipeline_step::generate,
        .outcome = made->failed == 0 ? step_outcome::resolved : step_outcome::partial,
        .start = {},
        .end = {},
        .detail = std::format(
            "{} resolved, {} failed, {} warning(s)", made->resolved, made->failed, made->warnings
        ),
    };
}

auto add_to(generation& tally, const result<module_values>& made) -> void {
    if (!made) {
        ++tally.failed;
        return;
    }
    tally.resolved += made->resolved;
    tally.failed += made->failed;
    tally.resolved_keys.append_range(made->resolved_keys);
}

// A core capability any of whose facts didn't resolve would refuse every session on this build.
auto report_core_coverage(
    const bundle::release_manifest_v3& release,
    std::span<const finder::fact_search> searches,
    generation& tally
) -> void {
    for (const bundle::manifest_capability& capability : release.capabilities) {
        if (capability.level != bundle::capability_level::core) {
            continue;
        }
        std::string missing;
        for (const u64 member : capability.members) {
            if (!std::ranges::contains(tally.resolved_keys, member)) {
                missing += missing.empty() ? "" : ", ";
                missing += fact_name(member, searches);
            }
        }
        if (!missing.empty()) {
            std::println(
                "  error: core capability {:#018x} is uncovered: {} didn't resolve",
                capability.key,
                missing
            );
            ++tally.uncovered_core;
        }
    }
}

}

auto generate(
    const generation_source& source,
    const finder::target& target,
    stdx::function_ref<wall_time()> now
) -> result<generation> {
    const module_manifest linked = LUCENT_TRY(manifest_of(source.module));
    const std::span<const kit::fact_record> manifest = linked.facts;
    const bundle::release_manifest_v3 release = LUCENT_TRY(release_manifest_of(linked, target));
    std::println(
        "{} links {} fact(s) in {} capabilities, manifest digest {}; {} searched for {}",
        source.module.filename().string(),
        manifest.size(),
        release.capabilities.size(),
        hex_of(kit::manifest_of(manifest)),
        target.searches.size(),
        target.name
    );
    generation tally;
    const std::vector<covered_fact> covered = coverage(manifest, target.searches, tally);
    for (const kit::game_module& game : target.modules) {
        if (!std::ranges::contains(covered, game.index, [](const covered_fact& fact) {
                return fact.search.module;
            })) {
            continue;
        }
        const wall_time start = now();
        const result<module_values> made = generate_module(source, game, covered);
        add_to(tally, made);
        step_record step = step_of(game, made);
        step.start = start;
        step.end = now();
        tally.steps.push_back(std::move(step));
    }
    for (const covered_fact& fact : covered) {
        if (!std::ranges::contains(target.modules, fact.search.module, &kit::game_module::index)) {
            std::println(
                "  error: {}: no module {} in {}'s table",
                fact.search.fact,
                fact.search.module,
                target.name
            );
            ++tally.failed;
        }
    }
    report_core_coverage(release, target.searches, tally);
    return tally;
}

}
