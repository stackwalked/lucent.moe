#include "cli/describe.hpp"

#include <format>
#include <string>
#include <string_view>

namespace lucent::loader_dev {
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
    return "unknown";
}

}

auto describe(const error& failure) -> std::string {
    if (failure.code == error_code::system) {
        return std::format("system error {}", failure.system_code);
    }
    return std::string{name_of(failure.code)};
}

}
