#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>
#include <type_traits>
#include <variant>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/foreign_ptr32.hpp>
#include <lucent/os/process.hpp>

namespace lucent::foreign {

// A value that can be copied out of foreign memory as its bytes. A raw pointer can't: a pointer
// foreign memory holds is a foreign_ptr.
template <typename T>
concept readable = std::is_trivially_copyable_v<T> && !std::is_pointer_v<T>;

// Where foreign memory is read from: a mapped module reads its own process, the host reads its
// target through a process handle, and tests read bytes laid out at an address. Domains and
// features read the same way from all three.
class memory_source final {
public:
    static auto this_process() -> memory_source;
    // The process object must outlive the source.
    static auto from_process(const os::process& target) -> memory_source;
    // The bytes must outlive the source; they appear at `base`.
    static auto from_bytes(u64 base, std::span<const std::byte> bytes) -> memory_source;

    // Fills `into` from the foreign bytes at `address`. Fails when any of them can't be read, and
    // `into` then holds nothing usable.
    auto read(u64 address, std::span<std::byte> into) const -> result<void>;

private:
    struct own_memory {};

    struct process_memory {
        const os::process* target = nullptr;
    };

    struct laid_out_bytes {
        u64 base = 0;
        std::span<const std::byte> bytes;
    };

    using source = std::variant<own_memory, process_memory, laid_out_bytes>;

    explicit memory_source(source from);

    source m_source;
};

// A null pointer fails like an unreadable one: both came from foreign memory.
template <readable T>
auto read(const memory_source& source, foreign_ptr<T> pointer) -> result<T> {
    if (is_null(pointer)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::array<std::byte, sizeof(T)> bytes{};
    LUCENT_TRY(source.read(pointer.address, bytes));
    return std::bit_cast<T>(bytes);
}

template <readable T>
auto read(const memory_source& source, foreign_ptr32<T> pointer) -> result<T> {
    return read(source, foreign_ptr<T>{.address = pointer.address});
}

}
