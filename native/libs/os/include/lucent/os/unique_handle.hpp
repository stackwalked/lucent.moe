#pragma once

namespace lucent::os {

// Owns a Windows kernel handle and closes it when destroyed. The handle is a void* so that this
// header stays free of windows.h.
class unique_handle final {
public:
    unique_handle() = default;
    explicit unique_handle(void* handle);
    unique_handle(const unique_handle&) = delete ("a kernel handle has one owner");
    auto operator=(const unique_handle&)
        -> unique_handle& = delete ("a kernel handle has one owner");
    unique_handle(unique_handle&& other) noexcept;
    auto operator=(unique_handle&& other) noexcept -> unique_handle&;
    ~unique_handle();

    auto native() const -> void*;
    auto is_valid() const -> bool;
    // Gives up ownership without closing.
    auto release() -> void*;

private:
    void* m_handle = nullptr;
};

}
