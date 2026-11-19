#include <lucent/integrity/module_census.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <vector>

#include <Windows.h>

#include <Psapi.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

namespace lucent::integrity {
namespace {

auto own_executable_hash() -> crypto::digest {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    const result<std::vector<std::byte>> contents = os::read_file(std::filesystem::path{path});
    REQUIRE(contents.has_value());
    return crypto::hash(*contents);
}

auto module_count() -> usize {
    std::array<HMODULE, 1024> modules{};
    DWORD needed = 0;
    REQUIRE(
        K32EnumProcessModulesEx(
            GetCurrentProcess(), modules.data(), sizeof(modules), &needed, LIST_MODULES_ALL
        )
        != 0
    );
    return needed / sizeof(HMODULE);
}

auto counted(const module_census& census) -> usize {
    return usize{census.by_microsoft} + census.by_other_signer + census.without_signature
           + census.unreadable;
}

auto hashed(const module_census& census) -> std::span<const crypto::digest> {
    return std::span{census.unsigned_files}.first(census.unsigned_file_count);
}

// Every Windows loads ntdll, catalog-signed by Microsoft, into every process; the test executable
// carries no signature.
TEST_CASE("this process's modules are each counted, with Microsoft's and our unsigned file seen") {
    const crypto::digest own = own_executable_hash();
    // Taken first: verifying signatures loads more of Windows into the process.
    const usize loaded = module_count();
    const result<module_census> census = module_census_of(GetCurrentProcess(), {});
    REQUIRE(census.has_value());

    CHECK(counted(*census) == loaded);
    CHECK(census->by_microsoft >= 1);
    CHECK(census->without_signature >= 1);
    CHECK(std::ranges::contains(hashed(*census), own));
}

TEST_CASE("a known unsigned file is counted but takes no hash slot") {
    const std::array<crypto::digest, 1> known{own_executable_hash()};
    const result<module_census> census = module_census_of(GetCurrentProcess(), known);
    REQUIRE(census.has_value());

    CHECK(census->without_signature >= 1);
    CHECK_FALSE(std::ranges::contains(hashed(*census), known[0]));
}

}
}
