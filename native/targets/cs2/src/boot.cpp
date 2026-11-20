#include <utility>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/lifecycle.hpp>

#include "attach.hpp"
#include "trusted_keys.hpp"

// The module's way in, for either loader: once the image is in (mapped, or by LoadLibraryW) and its
// entry point has run, the host starts this export on a remote thread, with boot_info written into
// this process. A container keeps no export names: pack records this one's RVA as its boot entry.
// The signature is Win32's LPTHREAD_START_ROUTINE; the exit code is 0 or an error_code plus one.
extern "C" __declspec(dllexport) auto lucent_boot(const void* parameter) -> unsigned long;

extern "C" auto lucent_boot(const void* parameter) -> unsigned long {
    const auto* const given = static_cast<const lucent::kit::boot_info*>(parameter);
    // The version first: another version's boot_info may be shorter than this one.
    if (given->version != lucent::kit::boot_info_version) {
        return std::to_underlying(lucent::error_code::version_mismatch) + 1UL;
    }
    const lucent::kit::boot_info info = *given;
    const lucent::kit::target cs2{
        .attach = &lucent::cs2::attach,
        .modules = lucent::cs2::game_modules,
        .trusted = lucent::cs2::trusted_keys(),
    };
    const lucent::result<void> started = lucent::kit::start(info, cs2);
    return started ? 0UL : std::to_underlying(started.error().code) + 1UL;
}
