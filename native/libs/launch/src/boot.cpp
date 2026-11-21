#include <lucent/launch/boot.hpp>

#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>

#include <lucent/core/match.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::launch {

auto boot_entry_offset(std::span<const std::byte> module_file) -> result<u32> {
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(module_file, pe::layout::file));
    const pe::export_table exports = LUCENT_TRY(pe::export_table::from_image(image));
    return match(
        LUCENT_TRY(exports.find("lucent_boot")),
        [](const pe::export_address& address) -> result<u32> { return address.rva; },
        // Our own entry point is never forwarded; if it is, this isn't the module we built.
        [](const pe::forwarder&) -> result<u32> {
            return std::unexpected(error{.code = error_code::malformed});
        }
    );
}

auto start_module(const os::process& target, const boot_request& request) -> result<void> {
    kit::boot_info info = request.info;
    std::optional<os::remote_region> remote_bundle;
    if (!request.bundle.empty()) {
        remote_bundle.emplace(LUCENT_TRY(
            os::remote_region::allocate(target, request.bundle.size(), os::page_access::read_write)
        ));
        LUCENT_TRY(remote_bundle->write(0, request.bundle));
        info.bundle = std::bit_cast<const std::byte*>(remote_bundle->base());
        info.bundle_size = request.bundle.size();
    }
    const std::span<const std::byte> bytes = std::as_bytes(std::span{&info, 1});
    os::remote_region remote_info =
        LUCENT_TRY(os::remote_region::allocate(target, bytes.size(), os::page_access::read_write));
    LUCENT_TRY(remote_info.write(0, bytes));
    const u32 exit_code = LUCENT_TRY(
        os::run_remote(target, {.start = request.entry, .argument = remote_info.base()})
    );
    if (exit_code != 0) {
        // The entry reports failure as an error_code plus one.
        return std::unexpected(error{.code = static_cast<error_code>(exit_code - 1)});
    }
    return {};
}

}
