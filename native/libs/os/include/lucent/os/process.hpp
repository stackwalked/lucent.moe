#pragma once

#include <string_view>

#include <lucent/os/unique_handle.hpp>

namespace lucent::os {

// Another process, opened with the rights that loading code into it needs: memory, threads and
// handle duplication.
class process final {
public:
    static auto open(u32 id) -> result<process>;

    process(const process&) = delete ("one process object per open handle");
    auto operator=(const process&) -> process& = delete ("one process object per open handle");
    process(process&&) noexcept = default;
    auto operator=(process&&) noexcept -> process& = default;
    ~process() = default;

    auto id() const -> u32;
    auto native() const -> void*;

private:
    process(u32 id, unique_handle handle);

    u32 m_id;
    unique_handle m_handle;
};

// The first running process whose executable file has this name, compared case-insensitively.
auto find_process_id(std::string_view executable) -> result<u32>;

}
