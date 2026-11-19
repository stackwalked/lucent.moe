#include "generate/manifest.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <filesystem>
#include <span>
#include <vector>

#include <lucent/kit/fact.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::factgen {

// The same reading as devkey's (tools/devkey/src/sign/dev_bundle.cpp): a module's manifest is its
// .lfact section, whole records from its start.
auto manifest_of(const std::filesystem::path& module) -> result<std::vector<kit::fact_record>> {
    const std::vector<std::byte> file = LUCENT_TRY(os::read_file(module));
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(file, pe::layout::file));
    const auto section = std::ranges::find(image.sections(), ".lfact", &pe::section::name);
    if (section == image.sections().end()) {
        return std::vector<kit::fact_record>{};
    }
    std::span<const std::byte> bytes = LUCENT_TRY(image.contents_of(*section));
    std::vector<kit::fact_record> records;
    while (bytes.size() >= sizeof(kit::fact_record)) {
        std::array<std::byte, sizeof(kit::fact_record)> stored{};
        std::ranges::copy(bytes.first(sizeof(kit::fact_record)), stored.begin());
        const auto record = std::bit_cast<kit::fact_record>(stored);
        if (record.key != 0) {
            records.push_back(record);
        }
        bytes = bytes.subspan(sizeof(kit::fact_record));
    }
    return records;
}

}
