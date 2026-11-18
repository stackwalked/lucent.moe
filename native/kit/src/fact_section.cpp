#include <span>

#include <lucent/kit/fact.hpp>

namespace lucent::kit {
namespace {

// The section's bounds; every record between them is a fact object declared with LUCENT_FACT.
__declspec(allocate(".lfact$a")) constinit const fact_record section_begin{};
__declspec(allocate(".lfact$z")) constinit const fact_record section_end{};

}

auto linked_fact_records() -> std::span<const fact_record> {
    // build: lld-link 23.1.5, grouped sections `.lfact$a/$m/$z` merged in name order
    // found: tests/fact_section_test.cpp (two translation units, inline facts folded)
    // breaks: facts go unresolved, or a marker is read as a fact
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage" // bounded by the linker's own markers
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // as above
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic): the section is an array the linker laid out.
    return std::span<const fact_record>{&section_begin + 1, &section_end};
#pragma clang diagnostic pop
}

}
