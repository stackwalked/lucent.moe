#pragma once

#include <filesystem>
#include <string_view>

namespace lucent::facts {

// An empty directory under the system's temp folder, named for one test so tests running at once
// never share one. Emptied when the test next runs rather than when it ends, so a failure leaves
// what the test wrote to look at.
auto fresh_directory(std::string_view test) -> std::filesystem::path;

}
