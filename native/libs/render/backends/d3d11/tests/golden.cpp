#include "golden.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <Windows.h>

#include <d3d11.h>

#include <dxgiformat.h>
#include <wincodec.h>

#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/d3d11/offscreen.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/os/file.hpp>

// build: Windows SDK 10.0.26100.0 declares it only for drivers (km/wdm.h); ntdll exports it to user
//        mode on every Windows NT.
// found: documented in the WDK as RtlGetVersion(PRTL_OSVERSIONINFOW) returning NTSTATUS.
// breaks: link error against ntdll.lib, never a silent misread.
// NOLINTNEXTLINE(readability-identifier-naming): ntdll's name.
extern "C" __declspec(dllimport) auto __stdcall RtlGetVersion(OSVERSIONINFOW* info) -> LONG;

namespace lucent::d3d11::testing {
namespace {

constexpr isize bytes_per_pixel = 4;

auto is_same_size(draw::pixel_size left, draw::pixel_size right) -> bool {
    return left.width == right.width && left.height == right.height;
}

auto pixel_count(draw::pixel_size size) -> isize {
    return isize{size.width} * isize{size.height};
}

auto goldens_directory() -> std::filesystem::path {
    std::filesystem::path directory{LUCENT_GOLDENS_DIR};
    directory.make_preferred();
    return directory;
}

auto should_update_goldens() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_UPDATE_GOLDENS", value.data(), 2) == 1
           && value.front() == L'1';
}

auto as_text(std::span<const std::byte> bytes) -> std::string {
    std::string text;
    for (const std::byte value : bytes) {
        text.push_back(static_cast<char>(value));
    }
    return text;
}

auto trimmed(std::string_view text) -> std::string_view {
    const usize end = text.find_last_not_of(" \t\r\n");
    return end == std::string_view::npos ? std::string_view{} : text.substr(0, end + 1);
}

auto recorded_build(const std::filesystem::path& path) -> std::string {
    const result<std::vector<std::byte>> stored = os::read_file(path);
    if (!stored) {
        return "unknown";
    }
    return std::string{trimmed(as_text(*stored))};
}

auto running_build() -> std::string {
    const result<std::string> build = os_build();
    return build ? *build : std::string{"unknown"};
}

auto update_golden(std::string_view name, const image& actual) -> golden_outcome {
    const std::filesystem::path png = goldens_directory() / std::format("{}.png", name);
    std::error_code created;
    std::filesystem::create_directories(goldens_directory(), created);
    const std::string build = running_build() + "\n";
    const result<void> written_png = write_png(png, actual);
    const result<void> written_build = os::write_file(
        goldens_directory() / std::format("{}.build", name), std::as_bytes(std::span{build})
    );
    if (!written_png || !written_build) {
        return {
            .is_match = false,
            .report = std::format("could not write the golden {}", to_utf8(png.native())),
        };
    }
    return {.is_match = true, .report = std::format("wrote {}", to_utf8(png.native()))};
}

struct pixel_difference {
    u8 max_channel_delta = 0;
    isize pixels_over_tolerance = 0;
};

auto channel_delta(std::byte expected, std::byte seen) -> u8 {
    const i32 delta = i32{std::to_integer<u8>(expected)} - i32{std::to_integer<u8>(seen)};
    return narrow<u8>(delta < 0 ? -delta : delta);
}

auto difference_of(const image& expected, const image& seen) -> pixel_difference {
    pixel_difference difference;
    for (const auto [golden_texel, seen_texel] : std::views::zip(
             expected.rgba | std::views::chunk(bytes_per_pixel),
             seen.rgba | std::views::chunk(bytes_per_pixel)
         )) {
        u8 pixel_delta = 0;
        for (const auto [golden_channel, seen_channel] :
            std::views::zip(golden_texel, seen_texel)) {
            pixel_delta = std::max(pixel_delta, channel_delta(golden_channel, seen_channel));
        }
        difference.max_channel_delta = std::max(difference.max_channel_delta, pixel_delta);
        if (pixel_delta > golden_tolerance) {
            ++difference.pixels_over_tolerance;
        }
    }
    return difference;
}

auto is_well_formed(const image& pixels) -> bool {
    return std::cmp_equal(pixels.rgba.size(), pixel_count(pixels.size) * bytes_per_pixel);
}

}

auto check_golden(std::string_view name, const image& actual) -> golden_outcome {
    if (should_update_goldens()) {
        return update_golden(name, actual);
    }
    const std::filesystem::path png = goldens_directory() / std::format("{}.png", name);
    std::error_code looked;
    if (!std::filesystem::exists(png, looked)) {
        return {
            .is_match = false,
            .report = std::format(
                "no golden at {}; create it with `moon run d3d11:goldens`, then review it before "
                "committing",
                to_utf8(png.native())
            ),
        };
    }
    const result<image> stored = read_png(png);
    if (!stored) {
        return {
            .is_match = false,
            .report = std::format("could not read the golden {}", to_utf8(png.native())),
        };
    }
    const recorded_golden golden{
        .pixels = *stored,
        .os_build = recorded_build(goldens_directory() / std::format("{}.build", name)),
    };
    return verdict(golden, actual, running_build());
}

auto verdict(const recorded_golden& golden, const image& actual, std::string_view running_build)
    -> golden_outcome {
    LUCENT_INVARIANT(is_well_formed(golden.pixels) && is_well_formed(actual));
    golden_outcome outcome;
    if (!is_same_size(golden.pixels.size, actual.size)) {
        outcome.report = std::format(
            "size differs: golden {}x{}, actual {}x{}",
            golden.pixels.size.width,
            golden.pixels.size.height,
            actual.size.width,
            actual.size.height
        );
    } else {
        const pixel_difference difference = difference_of(golden.pixels, actual);
        outcome.is_match = difference.pixels_over_tolerance == 0;
        outcome.report = std::format(
            "max channel delta {}, {} pixels over tolerance {}",
            difference.max_channel_delta,
            difference.pixels_over_tolerance,
            golden_tolerance
        );
    }
    if (golden.os_build != running_build) {
        outcome.report += std::format(
            "\ndrift: golden from OS build {}, running {}", golden.os_build, running_build
        );
    }
    return outcome;
}

auto os_build() -> result<std::string> {
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (RtlGetVersion(&version) != 0) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    // The update build revision: the build number alone doesn't change with monthly updates,
    // which can change how WARP rasterizes.
    DWORD revision = 0;
    DWORD revision_size = sizeof(revision);
    const LSTATUS read = RegGetValueW(
        HKEY_LOCAL_MACHINE,
        LR"(SOFTWARE\Microsoft\Windows NT\CurrentVersion)",
        L"UBR",
        RRF_RT_REG_DWORD,
        nullptr,
        &revision,
        &revision_size
    );
    if (read != ERROR_SUCCESS) {
        return std::unexpected(error{.code = error_code::system, .system_code = narrow<u32>(read)});
    }
    return std::format("{}.{}", version.dwBuildNumber, revision);
}

}
