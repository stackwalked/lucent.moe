#pragma once

#include <concepts>
#include <functional>
#include <memory>
#include <type_traits>
#include <utility>

namespace lucent::stdx {

// std::function_ref (C++26, P0792) for the subset we call: a non-owning reference to a callable
// object. MSVC STL 14.51 doesn't ship it. Goes when the STL does.
template <typename Signature>
class function_ref;

template <typename R, typename... Args>
class function_ref<R(Args...)> final {
public:
    // Implicit, as std's is: a lambda passes straight to a function_ref parameter.
    template <typename F>
        requires(!std::same_as<std::remove_cvref_t<F>, function_ref>
                    && !std::is_function_v<std::remove_reference_t<F>>
                    && std::is_invocable_r_v<R, std::remove_reference_t<F>&, Args...>)
    // NOLINTNEXTLINE(google-explicit-constructor,cppcoreguidelines-explicit-constructor,misc-explicit-constructor,cppcoreguidelines-missing-std-forward): std's API; only the callable's address is kept, never the callable.
    function_ref(F&& callable) noexcept
        // The stored pointer drops const; call_as restores F's own constness before the call.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast): erased storage, typed again in call_as.
        : m_object{const_cast<void*>(static_cast<const void*>(std::addressof(callable)))}
        , m_call{&call_as<std::remove_reference_t<F>>} {}

    auto operator()(Args... args) const -> R {
        return m_call(m_object, std::forward<Args>(args)...);
    }

private:
    template <typename F>
    static auto call_as(void* object, Args... args) -> R {
        return std::invoke(*static_cast<F*>(object), std::forward<Args>(args)...);
    }

    void* m_object;
    R (*m_call)(void*, Args...);
};

}
