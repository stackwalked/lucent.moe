#pragma once

#include <array>
#include <cstddef>
#include <filesystem>
#include <flat_map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/wire/ids.hpp>

// What the loader keeps between runs, in one file under its install root, sealed with DPAPI to
// this Windows user. Losing it costs a sign-in and, at worst, accepting a rolled-back seal once
// more; it holds nothing that proves the PC (the device key does) or that runs.

namespace lucent::loader {

inline constexpr usize channel_count = 3;

struct saved_state {
    // The 30-day rotating refresh token; empty when signed out. Rotated on every refresh, so it is
    // saved before the new access token is used.
    std::string refresh_token;
    // Set once the member approved this PC, or the server said it already was. The device's id
    // isn't kept: the key proves the PC, and nothing the loader sends names the device.
    bool is_enrolled = false;
    wire::channel chosen = wire::channel::stable;
    // The highest loader seal number seen signed per channel, indexed by wire::channel: a seal at
    // or below it is a rollback and refused.
    std::array<u64, channel_count> highest_loader_seal{};
    // The same for each product's module seals, by product id.
    std::flat_map<std::string, std::array<u64, channel_count>> highest_module_seal;

    auto operator==(const saved_state&) const -> bool = default;
};

auto highest_seal_of(const saved_state& state, wire::channel chosen) -> u64;
auto raise_highest_seal(saved_state& state, wire::channel chosen, u64 number) -> void;

auto highest_module_seal_of(
    const saved_state& state, std::string_view product, wire::channel chosen
) -> u64;
auto raise_module_seal(
    saved_state& state, std::string_view product, wire::channel chosen, u64 number
) -> void;

// Version 1: a version byte, the token (u16 length, bytes), the enrolled flag, the channel,
// the three loader seal numbers, then a count of products and for each its id (u8 length, bytes)
// and three module seal numbers; numbers little-endian.
auto encode_saved_state(const saved_state& state) -> std::vector<std::byte>;

// Canonical or nothing.
auto decode_saved_state(std::span<const std::byte> bytes) -> result<saved_state>;

// The lucent folder under %LOCALAPPDATA%: the state file and every installed release live under it.
auto install_root() -> result<std::filesystem::path>;

// The state as saved, or a fresh one when there is none or it can't be opened (another user's,
// a damaged file): signing in again is always the way back.
auto load_saved_state(const std::filesystem::path& root) -> saved_state;

// Replaces the file whole, so a crash leaves the old state or the new one.
auto save_state(const std::filesystem::path& root, const saved_state& state) -> result<void>;

}
