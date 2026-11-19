#include <format>
#include <span>
#include <string>
#include <utility>

#include <lucent/core/fault.hpp>
#include <lucent/kit/dev_channel.hpp>
#include <lucent/kit/feature.hpp>

#include "dev.hpp"

// Dev builds only: kit's CMakeLists leaves this file out of every other configuration.

namespace lucent::kit::detail {

auto report_feature_fault(feature_id feature, const fault& caught) -> void {
    dev::report_incident(std::format("feature {:#018x}", std::to_underlying(feature)), caught);
}

namespace {

auto keys_of(std::span<const u64> capabilities) -> std::string {
    std::string keys;
    for (const u64 key : capabilities) {
        keys += std::format("{}{:#018x}", keys.empty() ? "" : ", ", key);
    }
    return keys;
}

}

auto report_refused_start(std::span<const u64> unavailable) -> void {
    dev::send_text(
        std::format("start refused: core capabilities unavailable: {}", keys_of(unavailable))
    );
}

auto report_waiting_core(std::span<const u64> waiting) -> void {
    dev::send_text(
        std::format("start goes on: core capabilities wait for their modules: {}", keys_of(waiting))
    );
}

auto report_late_core_failed(std::span<const u64> failed) -> void {
    dev::send_text(
        std::format(
            "session ends: core capabilities failed once their modules loaded: {}", keys_of(failed)
        )
    );
}

auto report_no_session_end(const error& failure) -> void {
    dev::send_text(
        std::format(
            "start refused: core capabilities wait, and the session can't be ended if they fail "
            "(error {}, system {})",
            std::to_underlying(failure.code),
            failure.system_code
        )
    );
}

}
