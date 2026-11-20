#include "inject/load.hpp"

#include <cstddef>
#include <expected>
#include <vector>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/process.hpp>
#include <lucent/wire/container.hpp>

#include "cli/options.hpp"
#include "inject/boot.hpp"
#include "inject/mapper.hpp"
#include "inject/os_loader.hpp"

namespace lucent::loader_dev {
namespace {

auto mapped_from(const mapped_module& mapped, u32 boot_offset) -> loaded_module {
    return loaded_module{
        .base = mapped.base,
        .boot_offset = boot_offset,
        .kind = kit::image_kind::mapped,
        .trampolines = mapped.trampolines,
        .entry_rva = mapped.entry_rva,
        .pdata_rva = mapped.pdata_rva,
        .pdata_size = mapped.pdata_size,
    };
}

// The mapper reads the file once and holds no lock on it, so the build can overwrite the
// original freely: no staged copy.
auto map_from(const os::process& target, const options& chosen) -> result<loaded_module> {
    const std::vector<std::byte> file = LUCENT_TRY(os::read_file(chosen.module));
    const u32 boot_offset = LUCENT_TRY(boot_entry_offset(file));
    return mapped_from(LUCENT_TRY(map_module(target, file)), boot_offset);
}

// pack refuses a module without a boot entry, so a container without one wasn't packed by ours.
auto map_container_from(const os::process& target, const options& chosen) -> result<loaded_module> {
    const std::vector<std::byte> packed = LUCENT_TRY(os::read_file(chosen.module));
    const wire::container image = LUCENT_TRY(wire::unpack_container(packed));
    if (image.boot_rva == 0) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    return mapped_from(LUCENT_TRY(map_container_module(target, image)), image.boot_rva);
}

auto load_with_os_loader(const os::process& target, const options& chosen)
    -> result<loaded_module> {
    const staged_module staged = LUCENT_TRY(stage_module(chosen.module));
    const u32 boot_offset = LUCENT_TRY(boot_entry_offset(staged.file));
    const uptr base = LUCENT_TRY(load_staged_module(target, staged));
    return loaded_module{
        .base = base,
        .boot_offset = boot_offset,
        .kind = kit::image_kind::loaded,
        .trampolines = 0,
        .entry_rva = 0,
        .pdata_rva = 0,
        .pdata_size = 0,
    };
}

}

auto load_module(const os::process& target, const options& chosen) -> result<loaded_module> {
    switch (chosen.loading) {
    case kit::image_kind::mapped:
        return is_container(chosen) ? map_container_from(target, chosen) : map_from(target, chosen);
    case kit::image_kind::loaded:
        return load_with_os_loader(target, chosen);
    }
    return std::unexpected(error{.code = error_code::malformed});
}

}
