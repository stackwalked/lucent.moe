#include "sign/dev_bundle.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <utility>
#include <vector>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/text.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::devkey {
namespace {

// The fact section as the linker wrote it into the file: kit's markers and any gaps have key 0,
// which the manifest skips, as the module's own walk of the section does.
auto linked_records(const pe::image_view& image) -> result<std::vector<kit::fact_record>> {
    const auto section = std::ranges::find(image.sections(), ".lfact", &pe::section::name);
    if (section == image.sections().end()) {
        return std::vector<kit::fact_record>{};
    }
    std::span<const std::byte> bytes = LUCENT_TRY(image.contents_of(*section));
    std::vector<kit::fact_record> records;
    while (bytes.size() >= sizeof(kit::fact_record)) {
        std::array<std::byte, sizeof(kit::fact_record)> stored{};
        std::ranges::copy(bytes.first(sizeof(kit::fact_record)), stored.begin());
        records.push_back(std::bit_cast<kit::fact_record>(stored));
        bytes = bytes.subspan(sizeof(kit::fact_record));
    }
    return records;
}

auto entries_for(std::span<const named_value> values, std::span<const kit::fact_record> records)
    -> result<std::vector<bundle::entry>> {
    std::vector<bundle::entry> entries;
    entries.reserve(values.size());
    for (const named_value& given : values) {
        const u64 key = kit::fact_name_hash(kit::dev_fact_seed, given.name);
        if (std::ranges::find(records, key, &kit::fact_record::key) == records.end()) {
            return std::unexpected(error{.code = error_code::not_found});
        }
        entries.push_back(bundle::literal(key, given.value));
    }
    return entries;
}

}

auto make_dev_bundle(const dev_bundle_request& request, const crypto::signing_key& signer)
    -> result<dev_bundle> {
    const std::vector<std::byte> module_file = LUCENT_TRY(os::read_file(request.module));
    const pe::image_view module = LUCENT_TRY(pe::image_view::parse(module_file, pe::layout::file));
    const std::vector<kit::fact_record> records = LUCENT_TRY(linked_records(module));

    const std::vector<std::byte> game_file = LUCENT_TRY(os::read_file(request.game_module));
    const pe::image_view game = LUCENT_TRY(pe::image_view::parse(game_file, pe::layout::file));
    const bundle::module_key build =
        LUCENT_TRY(kit::module_build_of(game, to_utf8(request.game_module.filename().wstring())));

    bundle::fact_set_header header;
    header.revision = 1;
    header.modules = {build};
    header.manifest_digest = kit::manifest_of(records);
    const bundle::fact_set set = bundle::sign_fact_set(
        std::move(header), LUCENT_TRY(entries_for(request.values, records)), signer
    );
    const auto manifest_size =
        static_cast<usize>(std::ranges::count_if(records, [](const kit::fact_record& record) {
            return record.key != 0;
        }));
    return dev_bundle{
        .bytes = bundle::encode_bundle(std::array{bundle::deliver_all(set)}),
        .build = build,
        .manifest_size = manifest_size,
    };
}

}
