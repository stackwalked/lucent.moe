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

auto report_refused_start(std::span<const u64> unavailable) -> void {
    std::string keys;
    for (const u64 key : unavailable) {
        keys += std::format("{}{:#018x}", keys.empty() ? "" : ", ", key);
    }
    dev::send_text(std::format("start refused: core capabilities unavailable: {}", keys));
}

}
