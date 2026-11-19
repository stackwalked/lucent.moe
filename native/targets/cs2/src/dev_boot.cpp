#include <array>
#include <utility>

#include <lucent/crypto/crypto.hpp>
#include <lucent/devkey/public_key.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/lifecycle.hpp>

#include "attach.hpp"

namespace lucent::cs2 {

// A dev-only fact that carries the bundle path end to end before cs2 has real facts: devkey signs
// a value for it (`dev_probe=<n>`), and the module's facts log shows it resolved. Nothing reads it,
// hence `used`: the compiler emits an inline variable only where something names it, and an
// unemitted fact is missing from the section and so from the manifest.
LUCENT_FACT kit::fact::value<i32> dev_probe [[gnu::used]]{
    "dev_probe",
    client_module,
    {.min = 0, .max = 1'000'000},
};

namespace {

// Dev builds trust this machine's dev key and nothing else (tools/devkey).
constexpr std::array<crypto::public_key, 1> trusted_keys{devkey::public_key};

constexpr kit::target cs2_target{
    .attach = &attach,
    .modules = game_modules,
    .trusted = trusted_keys,
};

}
}

// The dev loader's way in: once the image is in (mapped, or by LoadLibraryW), it starts this export
// on a remote thread, with boot_info written into this process. Dev builds only.
// The signature is Win32's LPTHREAD_START_ROUTINE; the exit code is 0 or an error_code plus one.
extern "C" __declspec(dllexport) auto lucent_boot(const void* parameter) -> unsigned long;

extern "C" auto lucent_boot(const void* parameter) -> unsigned long {
    const auto* const given = static_cast<const lucent::kit::boot_info*>(parameter);
    // The version first: another version's boot_info may be shorter than this one.
    if (given->version != lucent::kit::boot_info_version) {
        return std::to_underlying(lucent::error_code::version_mismatch) + 1UL;
    }
    const lucent::kit::boot_info info = *given;
    const lucent::result<void> started = lucent::kit::start(info, lucent::cs2::cs2_target);
    return started ? 0UL : std::to_underlying(started.error().code) + 1UL;
}
