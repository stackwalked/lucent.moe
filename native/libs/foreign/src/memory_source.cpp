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

// An address that can't be read is a foreign value that didn't hold up: it came from foreign
// memory or from a fact, never from us.
auto unreadable() -> error {
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
        return std::unexpected(unreadable());
    }
    return {};
}

auto read_laid_out(
    u64 base, std::span<const std::byte> bytes, u64 address, std::span<std::byte> into
) -> result<void> {
    if (address < base || address - base > bytes.size()) {
        return std::unexpected(unreadable());
    }
    const u64 offset = address - base;
    if (into.size() > bytes.size() - offset) {
        return std::unexpected(unreadable());
    }
    std::ranges::copy(bytes.subspan(offset, into.size()), into.begin());
    return {};
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

auto memory_source::from_bytes(u64 base, std::span<const std::byte> bytes) -> memory_source {
    return memory_source{laid_out_bytes{.base = base, .bytes = bytes}};
}

auto memory_source::read(u64 address, std::span<std::byte> into) const -> result<void> {
    return match(
        m_source,
        [&](own_memory) { return read_own(address, into); },
        [&](process_memory process) {
            return os::read_remote(*process.target, narrow<uptr>(address), into);
        },
        [&](laid_out_bytes laid_out) {
            return read_laid_out(laid_out.base, laid_out.bytes, address, into);
        }
    );
}

}
