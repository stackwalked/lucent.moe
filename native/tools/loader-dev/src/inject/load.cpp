#include "inject/load.hpp"

#include <cstddef>
#include <expected>
#include <optional>
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

// The mapper reads the file once and holds no lock on it, so the build can overwrite the
// original freely: no staged copy.
auto map_from(const os::process& target, const options& chosen) -> result<loaded_module> {
    const std::vector<std::byte> file = LUCENT_TRY(os::read_file(chosen.module));
    const u32 boot_offset = LUCENT_TRY(boot_entry_offset(file));
    const mapped_module mapped = LUCENT_TRY(map_module(target, file));
    return loaded_module{
        .base = mapped.base,
        .boot_offset = boot_offset,
        .kind = kit::image_kind::mapped,
        .trampolines = mapped.trampolines,
    };
}

// The container's header names its boot entry; a container without one (a release module, until
// kit's release boot path lands) is mapped and attached, and nothing more.
auto map_container_from(const os::process& target, const options& chosen) -> result<loaded_module> {
    const std::vector<std::byte> packed = LUCENT_TRY(os::read_file(chosen.module));
    const wire::container image = LUCENT_TRY(wire::unpack_container(packed));
    const mapped_module mapped = LUCENT_TRY(map_container_module(target, image));
    return loaded_module{
        .base = mapped.base,
        .boot_offset = image.boot_rva == 0 ? std::nullopt : std::optional<u32>{image.boot_rva},
        .kind = kit::image_kind::mapped,
        .trampolines = mapped.trampolines,
    };
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
