#include <cstdio>
#include <print>
#include <span>
#include <utility>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

#include "cli/options.hpp"
#include "key/header.hpp"
#include "key/seed.hpp"
#include "sign/dev_bundle.hpp"

namespace lucent::devkey {
namespace {

auto run(const header_command& chosen) -> result<void> {
    const crypto::signing_key signer = LUCENT_TRY(dev_signing_key());
    return write_public_key_header(chosen.header, signer.public_part());
}

auto run(const sign_command& chosen) -> result<void> {
    const crypto::signing_key signer = LUCENT_TRY(dev_signing_key());
    const dev_bundle made = LUCENT_TRY(make_dev_bundle(chosen.request, signer));
    LUCENT_TRY(os::write_file(chosen.bundle, made.bytes));
    std::println(
        "signed {} value(s) for {} (TimeDateStamp {:#010x}, SizeOfImage {:#x}), against a "
        "manifest of {} fact(s): {}",
        chosen.request.values.size(),
        chosen.request.game_module.filename().string(),
        made.build.time_date_stamp,
        made.build.size_of_image,
        made.manifest_size,
        chosen.bundle.string()
    );
    return {};
}

}
}

// The CRT's entry signature. argv is the CRT's array of argc pointers: the one place a span is
// built from a pointer and a count, and everything after reads it through that span.
// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT calls wmain by this name and signature, as it does main.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> arguments{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    const lucent::result<lucent::devkey::command> chosen = lucent::devkey::parse_command(arguments);
    if (!chosen) {
        return 2;
    }
    const lucent::result<void> ran = lucent::match(
        *chosen,
        [](const lucent::devkey::header_command& command) { return lucent::devkey::run(command); },
        [](const lucent::devkey::sign_command& command) { return lucent::devkey::run(command); }
    );
    if (!ran) {
        std::println(
            stderr,
            "devkey: failed with error code {} (system code {})",
            std::to_underlying(ran.error().code),
            ran.error().system_code
        );
        return 1;
    }
    return 0;
}
