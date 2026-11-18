#pragma once

// The bundle format's constants, version 1. A change that isn't additive bumps format_version;
// a module declares which versions it reads.

namespace lucent::bundle::detail {

// "LFS1" and "LFB1" as little-endian u32s.
inline constexpr u32 fact_set_magic = 0x3153'464c;
inline constexpr u32 bundle_magic = 0x3142'464c;
inline constexpr u16 format_version = 1;

// Sanity bounds on what a decoder accepts.
inline constexpr usize max_modules = 64;
inline constexpr usize max_entries = usize{1} << 20U;
inline constexpr usize max_sets = 256;

inline constexpr usize literal_size = 8;

}
