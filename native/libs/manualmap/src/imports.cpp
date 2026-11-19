#include "imports.hpp"

#include <cstddef>
#include <optional>
#include <span>

#include <lucent/core/match.hpp>
#include <lucent/os/process.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/wire/container.hpp>

#include "image_bytes.hpp"
#include "resolver.hpp"

namespace lucent::manualmap::detail {
namespace {

auto symbol_of(const pe::import_target& target) -> symbol {
    return match(
        target,
        [](const pe::import_by_name& by_name) { return symbol{by_name.name}; },
        [](pe::export_ordinal ordinal) { return symbol{ordinal}; }
    );
}

}

auto bind_imports(
    const os::process& target, const pe::image_view& image, std::span<std::byte> local
) -> result<void> {
    resolver exports{target, std::nullopt};
    for (const pe::import_module& module : LUCENT_TRY(pe::imports_of(image))) {
        for (const pe::import_entry& entry : module.entries) {
            const uptr address = LUCENT_TRY(exports.resolve(module.name, symbol_of(entry.target)));
            LUCENT_TRY(write_u64(local, entry.slot_rva, address));
        }
    }
    return {};
}

auto bind_hashed_imports(
    const os::process& target, const wire::container& image, std::span<std::byte> local
) -> result<void> {
    resolver exports{target, image.imports_key};
    for (const wire::container_import& entry : image.imports) {
        const uptr address = LUCENT_TRY(exports.resolve_import(entry));
        LUCENT_TRY(write_u64(local, entry.slot_rva, address));
    }
    return {};
}

}
