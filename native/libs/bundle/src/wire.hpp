#pragma once

#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <vector>

// Little-endian, fixed-width encoding for the bundle format; nothing in it is aligned or padded.

namespace lucent::bundle::detail {

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
        if (count > m_bytes.size() - m_offset) {
            return std::unexpected(error{.code = error_code::malformed});
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

}
