#include <lucent/kit/unique_handle.hpp>

#include <utility>

#include <Windows.h>

namespace lucent::kit {

unique_handle::unique_handle(void* handle)
    : m_handle(handle == INVALID_HANDLE_VALUE ? nullptr : handle) {}

unique_handle::unique_handle(unique_handle&& other) noexcept
    : m_handle(std::exchange(other.m_handle, nullptr)) {}

auto unique_handle::operator=(unique_handle&& other) noexcept -> unique_handle& {
    if (this != &other) {
        const unique_handle closing{
            std::exchange(m_handle, std::exchange(other.m_handle, nullptr))
        };
    }
    return *this;
}

unique_handle::~unique_handle() {
    if (m_handle != nullptr) {
        CloseHandle(m_handle);
    }
}

auto unique_handle::native() const -> void* {
    return m_handle;
}

auto unique_handle::is_valid() const -> bool {
    return m_handle != nullptr;
}

auto unique_handle::release() -> void* {
    return std::exchange(m_handle, nullptr);
}

}
