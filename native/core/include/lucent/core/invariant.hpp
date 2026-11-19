#pragma once

#include <source_location>

// Whether a failed check records where it is as text. 1 in dev builds, 0 in every other (core's
// CMakeLists): a release image holds no file or function name, since a function templated on a
// feature or a fact is named by it. Release faults carry the check's RVA instead, which the PDB
// archived with the release symbolizes.
#ifndef LUCENT_READABLE_CHECKS
#error "core's CMakeLists defines LUCENT_READABLE_CHECKS for every unit that includes core"
#endif

namespace lucent {

inline constexpr bool has_readable_checks = LUCENT_READABLE_CHECKS != 0;

// Called with the location of a failed invariant and must not return. The host installs one at
// startup: the module fails fast, tests throw so the failure can be asserted. The location is
// empty unless has_readable_checks.
using invariant_handler = void (*)(std::source_location where);

auto set_invariant_handler(invariant_handler handler) -> void;

// Runs the installed handler, then fails fast if it returned.
[[noreturn]] auto invariant_violated(std::source_location where) -> void;

}

// Our own code is wrong: never recovered from. In a constant expression a violation is a compile
// error, because the handler is not constexpr.
//
// A path our own logic rules out, such as leaving a switch that names every enumerator, is
// LUCENT_UNREACHABLE(). It fails fast like any broken invariant and is never an optimizer hint:
// std::unreachable would make reaching it undefined behavior instead of a crash report.
//
// Both record their location as text in dev builds only: outside them the location is empty, so no
// source_location literal is emitted into a release image.
#if LUCENT_READABLE_CHECKS
#define LUCENT_INVARIANT(condition)                                                                \
    ((condition) ? static_cast<void>(0)                                                            \
                 : ::lucent::invariant_violated(::std::source_location::current()))
#define LUCENT_UNREACHABLE() ::lucent::invariant_violated(::std::source_location::current())
#else
#define LUCENT_INVARIANT(condition)                                                                \
    ((condition) ? static_cast<void>(0) : ::lucent::invariant_violated(::std::source_location{}))
#define LUCENT_UNREACHABLE() ::lucent::invariant_violated(::std::source_location{})
#endif
