#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/os/process.hpp>

namespace lucent::os {

enum class page_access : u8 { none, read, read_write, read_execute, read_write_execute };

// Part of a region, by offset from its base.
struct region_range {
    usize offset = 0;
    usize size = 0;
};

// A range of another process's address space.
struct remote_range {
    uptr address = 0;
    usize size = 0;
};

// Memory committed in another process and freed with this object unless released. The process
// object must outlive it.
class remote_region final {
public:
    static auto allocate(const process& owner, usize size, page_access access)
        -> result<remote_region>;

    remote_region(const remote_region&) = delete ("remote memory has one owner");
    auto operator=(const remote_region&) -> remote_region& = delete ("remote memory has one owner");
    remote_region(remote_region&& other) noexcept;
    auto operator=(remote_region&&) -> remote_region& = delete ("a region is bound to its process");
    ~remote_region();

    auto base() const -> uptr;
    auto size() const -> usize;

    auto write(usize offset, std::span<const std::byte> bytes) -> result<void>;
    auto protect(region_range range, page_access access) -> result<void>;

    // Leaves the memory allocated, for whoever takes it over (a self-unloading module, say).
    auto release() -> uptr;

private:
    remote_region(void* process, remote_range range);

    void* m_process;
    uptr m_base;
    usize m_size;
};

auto read_remote(const process& owner, remote_range range) -> result<std::vector<std::byte>>;

// Fills `into` from `address` in the other process, allocating nothing: the host's reads of its
// target run at the input domain's rate.
auto read_remote(const process& owner, uptr address, std::span<std::byte> into) -> result<void>;

auto write_remote(const process& owner, uptr address, std::span<const std::byte> bytes)
    -> result<void>;

}
