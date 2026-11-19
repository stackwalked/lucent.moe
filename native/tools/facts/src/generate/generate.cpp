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
#include <vector>

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/core/narrow.hpp>
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
#include "generate/kind_check.hpp"
#include "generate/manifest.hpp"

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

// Runs one fact's finders. Its value, when they agree and it passes its kind's check.
auto resolve_one(
    const covered_fact& fact, const probe::module_file& module, const probe::code_index& index
) -> std::optional<u64> {
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
        return std::nullopt;
    }
    if (const std::optional<kind_flaw> flaw = kind_flaw_of(module, fact.record, settled->value)) {
        std::println("  error: {}: {:#x} is {}", fact.search.fact, settled->value, describe(*flaw));
        return std::nullopt;
    }
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
        }
    }
    return settled->value;
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

auto generate_module(
    const kit::game_module& game, std::span<const covered_fact> facts, generation& tally
) -> result<void> {
    const snapshot taken = LUCENT_TRY(latest_snapshot(game.name));
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
    for (const covered_fact& fact : facts) {
        if (fact.search.module != game.index) {
            continue;
        }
        if (const std::optional<u64> value = resolve_one(fact, module, index)) {
            values += std::format("{}={:#x}\n", fact.search.fact, *value);
            ++tally.resolved;
            tally.resolved_keys.push_back(fact.record.key);
        } else {
            ++tally.failed;
        }
    }
    const std::filesystem::path written = taken.directory / L"facts.txt";
    LUCENT_TRY(os::write_file(written, std::as_bytes(std::span{values})));
    std::println("  values: {}", written.string());
    std::println(
        R"(  sign:   devkey sign <module.dll> "{}" <out.bundle> "@{}")",
        taken.file.string(),
        written.string()
    );
    return {};
}

// A core capability any of whose facts didn't resolve would refuse every session on this build.
auto report_core_coverage(
    const bundle::release_manifest& release,
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

auto generate(const std::filesystem::path& module, const finder::target& target)
    -> result<generation> {
    const module_manifest linked = LUCENT_TRY(manifest_of(module));
    const std::span<const kit::fact_record> manifest = linked.facts;
    const bundle::release_manifest release =
        LUCENT_TRY(release_manifest_of(linked, game_of(target)));
    std::println(
        "{} links {} fact(s) in {} capabilities, manifest digest {}; {} searched for {}",
        module.filename().string(),
        manifest.size(),
        release.capabilities.size(),
        hex_of(kit::manifest_of(manifest)),
        target.searches.size(),
        target.name
    );
    generation tally;
    const std::vector<covered_fact> covered = coverage(manifest, target.searches, tally);
    for (const kit::game_module& game : target.modules) {
        if (std::ranges::contains(covered, game.index, [](const covered_fact& fact) {
                return fact.search.module;
            })) {
            LUCENT_TRY(generate_module(game, covered, tally));
        }
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
