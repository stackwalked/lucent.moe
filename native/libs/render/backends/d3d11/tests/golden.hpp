#pragma once

#include <string>
#include <string_view>

#include <lucent/d3d11/offscreen.hpp>

// The harness the renderer's golden tests run on: a WARP device, targets of every format the
// renderer meets in a swap chain, readback to 8-bit RGBA, and comparison against PNGs in
// tests/fixtures/goldens. LUCENT_UPDATE_GOLDENS=1 (`moon run d3d11:goldens`) rewrites them instead.
namespace lucent::d3d11::testing {

inline constexpr u8 golden_tolerance = 3;

struct golden_outcome {
    bool is_match = false;
    // The largest channel difference, how many pixels exceed golden_tolerance and, when the golden
    // was recorded on another OS build, a drift line naming both.
    std::string report;
};

// A golden as stored: its pixels and the OS build that rendered them ("unknown" when unrecorded).
struct recorded_golden {
    image pixels;
    std::string os_build;
};

// Compares with tests/fixtures/goldens/<name>.png, golden_tolerance per channel. Under
// LUCENT_UPDATE_GOLDENS=1 it writes <name>.png and <name>.build (the OS build) instead and reports
// a match. A missing golden is a mismatch that says how to create it.
auto check_golden(std::string_view name, const image& actual) -> golden_outcome;

// What check_golden concludes from a golden it has read and the OS build it runs on.
auto verdict(const recorded_golden& golden, const image& actual, std::string_view running_build)
    -> golden_outcome;

// "<build>.<update build revision>", e.g. 26100.4652: what a golden records as its OS build.
auto os_build() -> result<std::string>;

}
