#pragma once

#include <span>
#include <vector>

#include <lucent/os/unique_handle.hpp>

namespace lucent::os {

// Every other thread of this process, suspended for as long as this object lives, with where
// each one stopped.
//
// While it lives the caller must not allocate, take a lock, or call anything that might: a frozen
// thread can hold the heap lock or the loader lock, and waiting on it would never end. Threads
// created after freezing began are not frozen.
class frozen_threads final {
public:
    static auto freeze_others() -> result<frozen_threads>;

    frozen_threads(const frozen_threads&) = delete ("resumes its threads once");
    auto operator=(const frozen_threads&) -> frozen_threads& = delete ("resumes its threads once");
    frozen_threads(frozen_threads&& other) noexcept = default;
    auto operator=(frozen_threads&&) -> frozen_threads& = delete ("resumes its threads once");
    ~frozen_threads();

    // The instruction pointer of each frozen thread, read after it had stopped.
    auto instruction_pointers() const -> std::span<const uptr>;

private:
    frozen_threads() = default;

    std::vector<unique_handle> m_threads;
    std::vector<uptr> m_instruction_pointers;
};

}
