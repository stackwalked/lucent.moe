#pragma once

#include <filesystem>
#include <vector>

#include <lucent/kit/fact.hpp>

namespace lucent::factgen {

// The facts a built module links: its fact section as the linker wrote it into the file, gaps and
// kit's markers (key 0) left out. What the generator must cover, kind for kind.
auto manifest_of(const std::filesystem::path& module) -> result<std::vector<kit::fact_record>>;

}
