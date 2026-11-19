#include "image/refusal.hpp"

#include <format>
#include <string>
#include <string_view>

namespace lucent::pack {
namespace {

auto reason_text(refusal_reason reason) -> std::string_view {
    switch (reason) {
    case refusal_reason::not_an_image:
        return "not a PE32+ image";
    case refusal_reason::tls_directory:
        return "a TLS directory (thread_local, __declspec(thread) or a thread-safe "
               "function-local static, ours or a dependency's)";
    case refusal_reason::delay_imports:
        return "delay-load imports";
    case refusal_reason::writable_and_executable:
        return "a section both writable and executable";
    case refusal_reason::misaligned_section:
        return "a section not on a page boundary";
    case refusal_reason::import_by_ordinal:
        return "an import by ordinal, which has no name to hash";
    case refusal_reason::import_outside_system32:
        return "an import from a module outside System32, which the loader can't find by hash";
    case refusal_reason::import_unresolved:
        return "an import this machine's module doesn't export, or a forwarder that doesn't end "
               "in an export it can hash";
    case refusal_reason::relocation_outside_image:
        return "a relocated address outside the image";
    case refusal_reason::outside_kept_sections:
        return "something the image needs in a section the container drops";
    case refusal_reason::missing_boot_entry:
        return "no lucent_boot export, and the boot entry is required";
    case refusal_reason::not_canonical:
        return "a layout the container format refuses";
    }
    return "an unknown reason";
}

}

auto describe(const refusal& refused) -> std::string {
    return std::format("{}: {}", reason_text(refused.reason), refused.detail);
}

}
