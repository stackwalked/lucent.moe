#pragma once

#include <cstddef>
#include <span>

#include <lucent/wire/container.hpp>
#include <lucent/wire/ids.hpp>

#include "image/refusal.hpp"

namespace lucent::pack {

// Whether a module without a lucent_boot export is refused. Release modules have none until
// kit's release boot path lands, so the release build packs them with a boot RVA of 0 for now.
enum class boot_entry : u8 {
    optional,
    required,
};

// What the container carries that the image doesn't, and how strict to be.
struct container_identity {
    wire::release_id release;
    u32 boot_info_version = 0;
    wire::import_key imports_key{};
    boot_entry boot = boot_entry::optional;
};

// The linked DLL as a container: sections at their RVAs without the discardable ones, each
// trimmed of trailing zero pages; relocation slots rebased to offsets from the image's base;
// imports as hashes, checked against this machine's modules; the lucent_boot export's RVA as the
// boot RVA; and every name the image's own
// directories hold (import names, the export directory, the debug directory's PDB path) zeroed.
auto container_from_image(std::span<const std::byte> file, const container_identity& identity)
    -> pack_result<wire::container>;

}
