#pragma once

#include <source_location>

namespace lucent {

// Called with the location of a failed invariant and must not return. The host installs one at
// startup: the module fails fast, tests throw so the failure can be asserted.
using invariant_handler = void (*)(std::source_location where);

auto set_invariant_handler(invariant_handler handler) -> void;

// Runs the installed handler, then fails fast if it returned.
[[noreturn]] auto invariant_violated(std::source_location where) -> void;

}

// Our own code is wrong: never recovered from. In a constant expression a violation is a compile
// error, because the handler is not constexpr.
#define LUCENT_INVARIANT(condition)                                                                \
    ((condition) ? static_cast<void>(0)                                                            \
                 : ::lucent::invariant_violated(::std::source_location::current()))

// A path our own logic rules out, such as leaving a switch that names every enumerator. It fails
// fast like any broken invariant and is never an optimizer hint: std::unreachable would make
// reaching it undefined behavior instead of a crash report.
#define LUCENT_UNREACHABLE() ::lucent::invariant_violated(::std::source_location::current())
