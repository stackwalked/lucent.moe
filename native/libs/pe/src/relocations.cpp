#include <lucent/pe/relocations.hpp>

#include <expected>
#include <optional>
#include <vector>

#include <lucent/pe/image_view.hpp>

#include "format.hpp"

namespace lucent::pe {

auto relocations_of(const image_view& image) -> result<std::vector<u32>> {
    const std::optional<directory> table = image.find_directory(directory_kind::base_relocations);
    if (!table) {
        return std::vector<u32>{};
    }
    std::vector<u32> slots;
    u32 offset = 0;
    // Every block is at least its 8-byte header, so the table's size bounds the walk.
    while (offset < table->size) {
        const auto block =
            LUCENT_TRY(detail::read_rva<detail::raw_relocation_block>(image, table->rva + offset));
        const bool is_well_formed = block.block_size >= sizeof(detail::raw_relocation_block)
                                    && block.block_size % sizeof(u16) == 0
                                    && block.block_size <= table->size - offset;
        if (!is_well_formed) {
            return std::unexpected(detail::malformed);
        }
        const u32 entries_rva = table->rva + offset + sizeof(detail::raw_relocation_block);
        const u32 entry_count =
            (block.block_size - sizeof(detail::raw_relocation_block)) / sizeof(u16);
        for (u32 index = 0; index < entry_count; ++index) {
            const u16 entry =
                LUCENT_TRY(detail::read_rva<u16>(image, entries_rva + (index * sizeof(u16))));
            const u16 type = entry >> 12U;
            if (type == detail::relocation_absolute) {
                continue;
            }
            if (type != detail::relocation_dir64) {
                return std::unexpected(error{.code = error_code::unsupported});
            }
            const u64 slot = u64{block.page_rva} + (entry & 0xfffU);
            if (slot + sizeof(u64) > image.size_of_image()) {
                return std::unexpected(detail::malformed);
            }
            slots.push_back(static_cast<u32>(slot));
        }
        offset += block.block_size;
    }
    return slots;
}

}
