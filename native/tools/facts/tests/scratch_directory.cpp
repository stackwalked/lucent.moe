#include "scratch_directory.hpp"

#include <filesystem>
#include <string_view>
#include <system_error>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/text.hpp>

namespace lucent::facts {

auto fresh_directory(std::string_view test) -> std::filesystem::path {
    std::filesystem::path directory =
        std::filesystem::temp_directory_path() / L"lucent-tests" / to_wide(test);
    std::error_code failure;
    std::filesystem::remove_all(directory, failure);
    REQUIRE_FALSE(failure);
    std::filesystem::create_directories(directory, failure);
    REQUIRE_FALSE(failure);
    return directory;
}

}
