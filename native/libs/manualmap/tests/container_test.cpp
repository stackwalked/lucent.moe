#include <lucent/wire/container.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/manualmap/map.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>

// The contained-probe fixture, packed by the real post-link tool (tools/pack) at build time and
// mapped into this test's own process.

namespace lucent::manualmap {
namespace {

auto probe() -> wire::container {
    const result<std::vector<std::byte>> packed = os::read_file(LUCENT_CONTAINED_PROBE_CONTAINER);
    REQUIRE(packed.has_value());
    const result<wire::container> image = wire::unpack_container(*packed);
    REQUIRE(image.has_value());
    return *image;
}

auto contains(const wire::container& image, std::string_view text) -> bool {
    const std::span<const std::byte> wanted = std::as_bytes(std::span{text});
    return std::ranges::any_of(image.sections, [&](const wire::container_section& section) {
        return !std::ranges::search(section.data, wanted).empty();
    });
}

TEST_CASE("a packed container keeps no import, debug or export name of its image") {
    const wire::container image = probe();

    CHECK_FALSE(image.imports.empty());
    CHECK_FALSE(contains(image, "SetEnvironmentVariableW"));
    CHECK_FALSE(contains(image, "KERNEL32"));
    CHECK_FALSE(contains(image, ".pdb"));
}

auto variable(const wchar_t* name) -> std::wstring {
    std::array<wchar_t, 16> value{};
    const DWORD size = GetEnvironmentVariableW(name, value.data(), narrow<DWORD>(value.size()));
    return std::wstring{value.data(), size};
}

struct started {
    result<void> attached;
    result<u32> booted;
};

// Maps the probe into this process, runs its entry point, then its boot entry. The image's CRT
// registered callbacks into it, so it stays mapped for the process's life.
auto map_and_start(const os::process& self, const wire::container& packed) -> started {
    result<mapped> image = map_container(self, packed);
    REQUIRE(image.has_value());
    started out{
        .attached = attach(self, *image, 0),
        .booted =
            os::run_remote(self, {.start = image->image.base() + packed.boot_rva, .argument = 0}),
    };
    std::ignore = image->image.release();
    if (image->trampolines) {
        std::ignore = image->trampolines->release();
    }
    return out;
}

TEST_CASE("a mapped container's entry, then its boot entry, run with its imports and .pdata") {
    const result<os::process> self = os::process::open(GetCurrentProcessId());
    REQUIRE(self.has_value());
    SetEnvironmentVariableW(L"LUCENT_CONTAINED_PROBE", nullptr);
    SetEnvironmentVariableW(L"LUCENT_CONTAINED_PROBE_BOOT", nullptr);
    const wire::container packed = probe();
    REQUIRE(packed.boot_rva != 0);

    const started ran = map_and_start(*self, packed);

    REQUIRE(ran.attached.has_value());
    CHECK(variable(L"LUCENT_CONTAINED_PROBE") == L"contained");
    CHECK(ran.booted == 0U);
    CHECK(variable(L"LUCENT_CONTAINED_PROBE_BOOT") == L"booted");
}

TEST_CASE("a container importing an export no module has fails to map as not found") {
    const result<os::process> self = os::process::open(GetCurrentProcessId());
    REQUIRE(self.has_value());
    wire::container image = probe();
    image.imports.front().function_hash ^= 1U;

    const result<mapped> mapped_image = map_container(*self, image);

    REQUIRE_FALSE(mapped_image.has_value());
    CHECK(mapped_image.error().code == error_code::not_found);
}

}
}
