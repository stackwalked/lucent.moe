#include "app/describe.hpp"

#include <format>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <lucent/wire/refusal.hpp>

namespace lucent::loader {
namespace {

auto name_of(error_code code) -> std::string_view {
    switch (code) {
    case error_code::system:
        return "system";
    case error_code::closed:
        return "closed";
    case error_code::malformed:
        return "malformed";
    case error_code::not_found:
        return "not found";
    case error_code::version_mismatch:
        return "version mismatch";
    case error_code::unsupported:
        return "unsupported";
    case error_code::timed_out:
        return "timed out";
    }
    LUCENT_UNREACHABLE();
}

}

auto describe(const error& failure) -> std::string {
    if (failure.code == error_code::system) {
        return std::format("system error {:#x}", failure.system_code);
    }
    return std::string{name_of(failure.code)};
}

auto describe(wire::refusal_code code) -> std::string {
    const std::optional<std::string_view> name = wire::name_of(code);
    if (name) {
        return std::string{*name};
    }
    return std::format("code {}, unknown to this loader", std::to_underlying(code));
}

}
