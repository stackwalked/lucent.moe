#include <source_location>

#include <catch2/catch_session.hpp>

#include <lucent/core/invariant.hpp>
#include <lucent/testing/invariant_violation.hpp>

namespace {

[[noreturn]] auto throw_violation(std::source_location where) -> void {
    throw lucent::testing::invariant_violation{.where = where};
}

}

// The test host: the same role the module's boot plays, installing the invariant handler before
// anything runs.
auto main(int argc, char* argv[]) -> int {
    lucent::set_invariant_handler(&throw_violation);
    return Catch::Session().run(argc, argv);
}
