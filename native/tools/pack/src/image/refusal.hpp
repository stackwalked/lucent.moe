#pragma once

#include <expected>
#include <string>

namespace lucent::pack {

// Why a linked module can't become a container. Each names something the module's code or its
// dependencies must change, not something the packer could work around.
enum class refusal_reason : u8 {
    // The file isn't a PE32+ image the pe library reads.
    not_an_image,
    // Static TLS: the mapper gives an image none (check_no_tls.cmake says why).
    tls_directory,
    // Delay-loaded imports resolve through the OS loader's helper at first call, by name.
    delay_imports,
    // A section both writable and executable.
    writable_and_executable,
    // A section not at a page boundary: the container maps whole pages.
    misaligned_section,
    // An import by ordinal has no name to hash.
    import_by_ordinal,
    // An import whose module the build machine's loader resolves outside System32, where the
    // loader can't find it by its hash.
    import_outside_system32,
    // An import the build machine's module doesn't export, or a forwarder chain that doesn't end
    // in an export within the bound.
    import_unresolved,
    // A relocated address outside the image: it can't be stored as an offset from the base.
    relocation_outside_image,
    // A relocation or import slot, .pdata or the entry point in a section the container drops
    // (discardable, such as .reloc).
    outside_kept_sections,
    // No lucent_boot export, or a forwarded one.
    missing_boot_entry,
    // A layout the container format refuses (wire::decode_container_body's rules).
    not_canonical,
};

struct refusal {
    refusal_reason reason = refusal_reason::not_an_image;
    // What it applies to: a section, an import, an address.
    std::string detail;
};

template <typename T>
using pack_result = std::expected<T, refusal>;

auto describe(const refusal& refused) -> std::string;

}
