#pragma once

#include <algorithm>
#include <array>
#include <concepts>
#include <cstddef>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/wire/ids.hpp>

// The encoding every /v1 message shares: little-endian fixed-width integers, nothing aligned or
// padded, each message opening with a 32-byte context naming its kind and version. Canonical:
// every value has one encoding, so a decoder that accepts bytes re-encodes them exactly, and the
// bytes a signature covers are the bytes that arrived.

namespace lucent::wire::detail {

inline constexpr usize context_size = 32;

inline constexpr error malformed{.code = error_code::malformed};

class writer final {
public:
    auto write_u8(u8 value) -> void {
        m_bytes.push_back(static_cast<std::byte>(value));
    }

    auto write_u16(u16 value) -> void {
        write_little<2>(value);
    }

    auto write_u32(u32 value) -> void {
        write_little<4>(value);
    }

    auto write_u64(u64 value) -> void {
        write_little<8>(value);
    }

    auto write_bytes(std::span<const std::byte> bytes) -> void {
        m_bytes.insert(m_bytes.end(), bytes.begin(), bytes.end());
    }

    // "lucent <kind> v<version>", NUL-padded to the context size.
    auto write_context(std::string_view kind, u32 version) -> void {
        const std::string text = std::format("lucent {} v{}", kind, version);
        LUCENT_INVARIANT(text.size() < context_size);
        std::array<std::byte, context_size> padded{};
        std::ranges::copy(std::as_bytes(std::span{text}), padded.begin());
        write_bytes(padded);
    }

    auto write_product(std::string_view product) -> void;

    // A module list: u8 count, then per module u64 name hash, u32 time-date stamp, u32 size of
    // image.
    auto write_modules(std::span<const bundle::module_key> modules) -> void;

    auto bytes() const -> std::span<const std::byte> {
        return m_bytes;
    }

    auto take() -> std::vector<std::byte> {
        return std::move(m_bytes);
    }

private:
    template <u32 Width>
    auto write_little(u64 value) -> void {
        for (u32 index = 0; index < Width; ++index) {
            m_bytes.push_back(static_cast<std::byte>((value >> (8U * index)) & 0xffU));
        }
    }

    std::vector<std::byte> m_bytes;
};

class reader final {
public:
    explicit reader(std::span<const std::byte> bytes)
        : m_bytes{bytes} {}

    auto read_u8() -> result<u8> {
        return read_little(1).transform([](u64 value) { return static_cast<u8>(value); });
    }

    auto read_u16() -> result<u16> {
        return read_little(2).transform([](u64 value) { return static_cast<u16>(value); });
    }

    auto read_u32() -> result<u32> {
        return read_little(4).transform([](u64 value) { return static_cast<u32>(value); });
    }

    auto read_u64() -> result<u64> {
        return read_little(8);
    }

    auto read_bytes(usize count) -> result<std::span<const std::byte>> {
        if (count > remaining()) {
            return std::unexpected(malformed);
        }
        const std::span<const std::byte> taken = m_bytes.subspan(m_offset, count);
        m_offset += count;
        return taken;
    }

    template <usize Size>
    auto read_array() -> result<std::array<std::byte, Size>> {
        const std::span<const std::byte> taken = LUCENT_TRY(read_bytes(Size));
        std::array<std::byte, Size> out{};
        std::ranges::copy(taken, out.begin());
        return out;
    }

    // Only 0 and 1.
    auto read_bool() -> result<bool> {
        const u8 value = LUCENT_TRY(read_u8());
        if (value > 1) {
            return std::unexpected(malformed);
        }
        return value == 1;
    }

    // The same kind at another version is version_mismatch; anything else is malformed.
    auto read_context(std::string_view kind, u32 version) -> result<void> {
        const std::span<const std::byte> taken = LUCENT_TRY(read_bytes(context_size));
        const std::string expected = std::format("lucent {} v{}", kind, version);
        std::array<std::byte, context_size> padded{};
        std::ranges::copy(std::as_bytes(std::span{expected}), padded.begin());
        if (std::ranges::equal(taken, padded)) {
            return {};
        }
        const std::string family = std::format("lucent {} v", kind);
        if (std::ranges::starts_with(taken, std::as_bytes(std::span{family}))) {
            return std::unexpected(error{.code = error_code::version_mismatch});
        }
        return std::unexpected(malformed);
    }

    auto read_product() -> result<std::string>;

    // Sorted, unique, at most max_start_modules, or malformed.
    auto read_modules() -> result<std::vector<bundle::module_key>>;

    auto remaining() const -> usize {
        return m_bytes.size() - m_offset;
    }

    auto is_at_end() const -> bool {
        return m_offset == m_bytes.size();
    }

private:
    auto read_little(u32 width) -> result<u64> {
        const std::span<const std::byte> taken = LUCENT_TRY(read_bytes(width));
        u64 value = 0;
        u32 shift = 0;
        for (const std::byte part : taken) {
            value |= static_cast<u64>(part) << shift;
            shift += 8;
        }
        return value;
    }

    std::span<const std::byte> m_bytes;
    usize m_offset = 0;
};

// Sorted ascending without repeats, within max_start_modules.
auto is_canonical_modules(std::span<const bundle::module_key> modules) -> bool;

// Sorted ascending without repeats, never 0, within max_features.
auto is_canonical_features(std::span<const u64> features) -> bool;

// Fails as malformed unless the whole input was read.
template <std::move_constructible T>
auto finish(const reader& input, T value) -> result<T> {
    if (!input.is_at_end()) {
        return std::unexpected(malformed);
    }
    return value;
}

}
