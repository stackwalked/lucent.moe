#include <format>
#include <string>
#include <string_view>
#include <utility>

#include <lucent/kit/dev_channel.hpp>
#include <lucent/kit/fact_apply.hpp>

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
        return "module not loaded";
    }
    return "unknown";
}

auto describe(const apply_report& report) -> std::string {
    std::string sets;
    for (const set_outcome outcome : report.sets) {
        sets += std::format("{}{}", sets.empty() ? "" : ", ", name_of(outcome));
    }
    return std::format(
        "facts: sets [{}]; {} resolved, {} rejected, {} unresolved, {} unknown, {} misplaced",
        sets,
        report.facts.resolved,
        report.facts.rejected,
        report.facts.unresolved,
        report.facts.unknown,
        report.misplaced
    );
}

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
    dev::send_text(describe(*applied));
}

auto report_no_bundle() -> void {
    dev::send_text("facts: no bundle, every fact unresolved");
}

}
