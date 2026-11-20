#include <cstddef>
#include <cstdio>
#include <print>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/core/build/subkeys.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/container.hpp>

#include "cli/options.hpp"
#include "image/convert.hpp"
#include "image/refusal.hpp"

namespace lucent::pack {
namespace {

// The import hashes' key, from this build's api subkey, so hashes differ per release and say
// nothing across releases. Derived under its own label: the api subkey is also what refract's
// resolver thunks will key with, and those must reach the same hashes.
auto imports_key() -> wire::import_key {
    constexpr std::string_view label = "lucent container imports v1";
    return crypto::keyed_hash(build::api_subkey, std::as_bytes(std::span{label}));
}

auto run(const options& chosen) -> i32 {
    const result<std::vector<std::byte>> file = os::read_file(chosen.module);
    if (!file) {
        std::println(stderr, "pack: can't read {}", chosen.module.string());
        return 1;
    }
    const pack_result<wire::container> made = container_from_image(
        *file,
        container_identity{
            .release = chosen.release,
            .boot_info_version = kit::boot_info_version,
            .imports_key = imports_key(),
        }
    );
    if (!made) {
        std::println(
            stderr, "pack: {} refused: {}", chosen.module.string(), describe(made.error())
        );
        return 1;
    }
    const std::vector<std::byte> packed = wire::pack_container(*made);
    if (!os::write_file(chosen.container, packed)) {
        std::println(stderr, "pack: can't write {}", chosen.container.string());
        return 1;
    }
    std::println(
        "pack: {} -> {} ({} section(s), {} relocation(s), {} import(s), boot entry {:#x}, {} bytes "
        "packed)",
        chosen.module.filename().string(),
        chosen.container.string(),
        made->sections.size(),
        made->relocations.size(),
        made->imports.size(),
        made->boot_rva,
        packed.size()
    );
    return 0;
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
    const lucent::result<lucent::pack::options> chosen = lucent::pack::parse_options(arguments);
    if (!chosen) {
        return 2;
    }
    return lucent::pack::run(*chosen);
}
