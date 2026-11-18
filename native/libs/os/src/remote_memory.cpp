#include <lucent/os/remote_memory.hpp>

#include <bit>
#include <cstddef>
#include <expected>
#include <source_location>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/os/process.hpp>

namespace lucent::os {
namespace {

auto protection_of(page_access access) -> DWORD {
    switch (access) {
    case page_access::none:
        return PAGE_NOACCESS;
    case page_access::read:
        return PAGE_READONLY;
    case page_access::read_write:
        return PAGE_READWRITE;
    case page_access::read_execute:
        return PAGE_EXECUTE_READ;
    case page_access::read_write_execute:
        return PAGE_EXECUTE_READWRITE;
    }
    invariant_violated(std::source_location::current());
}

}

auto remote_region::allocate(const process& owner, usize size, page_access access)
    -> result<remote_region> {
    void* const base = VirtualAllocEx(
        owner.native(), nullptr, size, MEM_COMMIT | MEM_RESERVE, protection_of(access)
    );
    if (base == nullptr) {
        return std::unexpected(last_system_error());
    }
    return remote_region{owner.native(), {.address = std::bit_cast<uptr>(base), .size = size}};
}

remote_region::remote_region(void* process, remote_range range)
    : m_process(process)
    , m_base(range.address)
    , m_size(range.size) {}

remote_region::remote_region(remote_region&& other) noexcept
    : m_process(other.m_process)
    , m_base(std::exchange(other.m_base, 0))
    , m_size(std::exchange(other.m_size, 0)) {}

remote_region::~remote_region() {
    if (m_base != 0) {
        VirtualFreeEx(m_process, std::bit_cast<void*>(m_base), 0, MEM_RELEASE);
    }
}

auto remote_region::base() const -> uptr {
    return m_base;
}

auto remote_region::size() const -> usize {
    return m_size;
}

auto remote_region::write(usize offset, std::span<const std::byte> bytes) -> result<void> {
    LUCENT_INVARIANT(offset <= m_size && bytes.size() <= m_size - offset);
    void* const address = std::bit_cast<void*>(m_base + offset);
    if (WriteProcessMemory(m_process, address, bytes.data(), bytes.size(), nullptr) == 0) {
        return std::unexpected(last_system_error());
    }
    return {};
}

auto remote_region::protect(region_range range, page_access access) -> result<void> {
    LUCENT_INVARIANT(range.offset <= m_size && range.size <= m_size - range.offset);
    void* const address = std::bit_cast<void*>(m_base + range.offset);
    DWORD previous = 0;
    if (VirtualProtectEx(m_process, address, range.size, protection_of(access), &previous) == 0) {
        return std::unexpected(last_system_error());
    }
    return {};
}

auto remote_region::release() -> uptr {
    m_size = 0;
    return std::exchange(m_base, 0);
}

auto read_remote(const process& owner, remote_range range) -> result<std::vector<std::byte>> {
    std::vector<std::byte> bytes(range.size);
    const void* const address = std::bit_cast<const void*>(range.address);
    if (ReadProcessMemory(owner.native(), address, bytes.data(), bytes.size(), nullptr) == 0) {
        return std::unexpected(last_system_error());
    }
    return bytes;
}

}
