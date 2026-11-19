#include <lucent/foreign/memory_source.hpp>

#include <algorithm>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>
#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_memory.hpp>

namespace lucent::foreign {
namespace {

// An address that can't be reached is a foreign value that didn't hold up: it came from foreign
// memory or from a fact, never from us.
auto unreachable() -> error {
    return error{.code = error_code::malformed};
}

auto read_own(u64 address, std::span<std::byte> into) -> result<void> {
    const contained<void> copied = contain([&] {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // contain() catches a fault
        const std::span<const std::byte> from{
            std::bit_cast<const std::byte*>(narrow<uptr>(address)),
            into.size(),
        };
#pragma clang diagnostic pop
        std::ranges::copy(from, into.begin());
    });
    if (!copied) {
        return std::unexpected(unreachable());
    }
    return {};
}

auto write_own(u64 address, std::span<const std::byte> bytes) -> result<void> {
    const contained<void> copied = contain([&] {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // contain() catches a fault
        const std::span<std::byte> into{
            std::bit_cast<std::byte*>(narrow<uptr>(address)),
            bytes.size(),
        };
#pragma clang diagnostic pop
        std::ranges::copy(bytes, into.begin());
    });
    if (!copied) {
        return std::unexpected(unreachable());
    }
    return {};
}

struct foreign_range {
    u64 address = 0;
    usize size = 0;
};

// The part of the laid-out bytes the range covers, when they cover all of it.
auto laid_out_part(u64 base, std::span<std::byte> bytes, foreign_range range)
    -> result<std::span<std::byte>> {
    if (range.address < base || range.address - base > bytes.size()) {
        return std::unexpected(unreachable());
    }
    const u64 offset = range.address - base;
    if (range.size > bytes.size() - offset) {
        return std::unexpected(unreachable());
    }
    return bytes.subspan(offset, range.size);
}

}

memory_source::memory_source(source from)
    : m_source{from} {}

auto memory_source::this_process() -> memory_source {
    return memory_source{own_memory{}};
}

auto memory_source::from_process(const os::process& target) -> memory_source {
    return memory_source{process_memory{.target = &target}};
}

auto memory_source::from_bytes(u64 base, std::span<std::byte> bytes) -> memory_source {
    return memory_source{laid_out_bytes{.base = base, .bytes = bytes}};
}

auto memory_source::read(u64 address, std::span<std::byte> into) const -> result<void> {
    return match(
        m_source,
        [&](own_memory) { return read_own(address, into); },
        [&](process_memory process) {
            return os::read_remote(*process.target, narrow<uptr>(address), into);
        },
        [&](laid_out_bytes laid_out) -> result<void> {
            const std::span<const std::byte> from = LUCENT_TRY(laid_out_part(
                laid_out.base, laid_out.bytes, {.address = address, .size = into.size()}
            ));
            std::ranges::copy(from, into.begin());
            return {};
        }
    );
}

auto memory_source::write(u64 address, std::span<const std::byte> bytes) const -> result<void> {
    return match(
        m_source,
        [&](own_memory) { return write_own(address, bytes); },
        [&](process_memory process) {
            return os::write_remote(*process.target, narrow<uptr>(address), bytes);
        },
        [&](laid_out_bytes laid_out) -> result<void> {
            const std::span<std::byte> into = LUCENT_TRY(laid_out_part(
                laid_out.base, laid_out.bytes, {.address = address, .size = bytes.size()}
            ));
            std::ranges::copy(bytes, into.begin());
            return {};
        }
    );
}

}
