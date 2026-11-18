#include <utility>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/lifecycle.hpp>

#include "attach.hpp"

// The dev loader's way in: once the image is in (mapped, or by LoadLibraryW), it starts this export
// on a remote thread, with boot_info written into this process. Dev builds only.
// The signature is Win32's LPTHREAD_START_ROUTINE; the exit code is 0 or an error_code plus one.
extern "C" __declspec(dllexport) auto lucent_boot(const void* parameter) -> unsigned long;

extern "C" auto lucent_boot(const void* parameter) -> unsigned long {
    const lucent::kit::boot_info info = *static_cast<const lucent::kit::boot_info*>(parameter);
    if (info.version != lucent::kit::boot_info_version) {
        return std::to_underlying(lucent::error_code::version_mismatch) + 1UL;
    }
    const lucent::result<void> started = lucent::kit::start(info, &lucent::cs2::attach);
    return started ? 0UL : std::to_underlying(started.error().code) + 1UL;
}
