#include <lucent/probe/module_file.hpp>

#include <bit>
#include <optional>
#include <string_view>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/pe/runtime_functions.hpp>

#include "images.hpp"

namespace lucent::probe {
namespace {

constexpr std::string_view text = "lucent probe module text";

TEST_CASE("a function's address read from disk maps to the function the unwinder finds") {
    const module_file module = own_module();
    const auto code = std::bit_cast<uptr>(&own_module);
    DWORD64 base = 0;
    const RUNTIME_FUNCTION* const unwound = RtlLookupFunctionEntry(code, &base, nullptr);
    REQUIRE(unwound != nullptr);

    const std::optional<pe::runtime_function> found = module.function_containing(own_rva(code));
    REQUIRE(found.has_value());
    CHECK(found.value_or(pe::runtime_function{}).begin == unwound->BeginAddress);
    CHECK(found.value_or(pe::runtime_function{}).end == unwound->EndAddress);
    CHECK(module.is_code(own_rva(code)));
}

TEST_CASE("absolute addresses are relative to the preferred base, and data isn't code") {
    const module_file module = own_module();
    const u32 data = own_rva(std::bit_cast<uptr>(text.data()));
    const u64 preferred = module.view().image_base();

    CHECK(module.rva_of(preferred + data) == data);
    CHECK_FALSE(module.rva_of(preferred - 1).has_value());
    CHECK_FALSE(module.rva_of(preferred + module.view().size_of_image()).has_value());
    CHECK_FALSE(module.is_code(data));
    CHECK_FALSE(module.function_containing(data).has_value());
}

}
}
