#include <format>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <lucent/kit/dev_channel.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/fact_resolve.hpp>

#include "dev.hpp"

// Dev builds only: kit's CMakeLists leaves this file out of every other configuration, so a
// release image holds none of this text.

namespace lucent::kit::detail {
namespace {

auto name_of(set_outcome outcome) -> std::string_view {
    switch (outcome) {
    case set_outcome::applied:
        return "applied";
    case set_outcome::unverified:
        return "unverified";
    case set_outcome::other_manifest:
        return "other manifest";
    case set_outcome::other_build:
        return "other module build";
    case set_outcome::module_absent:
        return "waiting for its module";
    }
    return "unknown";
}

struct outcomes {
    std::span<const set_outcome> sets;
    u32 misplaced = 0;
    resolve_report facts;
};

auto describe(std::string_view stage, const outcomes& decided) -> std::string {
    std::string sets;
    for (const set_outcome outcome : decided.sets) {
        sets += std::format("{}{}", sets.empty() ? "" : ", ", name_of(outcome));
    }
    return std::format(
        "{}: sets [{}]; {} resolved, {} rejected, {} unresolved, {} unknown, {} misplaced",
        stage,
        sets,
        decided.facts.resolved,
        decided.facts.rejected,
        decided.facts.unresolved,
        decided.facts.unknown,
        decided.misplaced
    );
}

}

auto report_late_facts(const late_report& report) -> void {
    dev::send_text(describe(
        "facts, late module",
        {.sets = report.sets, .misplaced = report.misplaced, .facts = report.facts}
    ));
}

auto report_no_load_signal(const error& failure) -> void {
    dev::send_text(
        std::format(
            "facts: can't watch DLL loads (error {}, system {}); sets waiting for a module stay "
            "unresolved",
            std::to_underlying(failure.code),
            failure.system_code
        )
    );
}

auto report_facts(const result<apply_report>& applied) -> void {
    if (!applied) {
        dev::send_text(
            std::format(
                "facts: the bundle doesn't decode (error {}), every fact unresolved",
                std::to_underlying(applied.error().code)
            )
        );
        return;
    }
    dev::send_text(describe(
        "facts", {.sets = applied->sets, .misplaced = applied->misplaced, .facts = applied->facts}
    ));
}

auto report_no_bundle() -> void {
    dev::send_text("facts: no bundle, every fact unresolved");
}

}
