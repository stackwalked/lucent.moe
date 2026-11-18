#pragma once

#include <atomic>
#include <bit>
#include <chrono>
#include <memory>
#include <span>
#include <type_traits>

namespace lucent::kit {

namespace detail {

// One hooked function's shared state: the original to call, and the calls inside its detour now.
struct hook_state {
    std::atomic<uptr> original{0};
    std::atomic<i32> in_flight{0};
};

// Counts one call inside a detour for as long as it runs. The detour holds it outside the
// handler, whose foreign work runs inside contain(), so a contained fault can't skip its
// destructor.
class in_flight_call final {
public:
    explicit in_flight_call(std::atomic<i32>& count)
        : m_count{&count} {
        m_count->fetch_add(1, std::memory_order_acq_rel);
    }

    in_flight_call(const in_flight_call&) = delete ("counts one call");
    auto operator=(const in_flight_call&) -> in_flight_call& = delete ("counts one call");
    in_flight_call(in_flight_call&&) = delete ("counts one call");
    auto operator=(in_flight_call&&) -> in_flight_call& = delete ("counts one call");

    ~in_flight_call() {
        m_count->fetch_sub(1, std::memory_order_release);
    }

private:
    std::atomic<i32>* m_count;
};

}

// What hook_set needs to hook one target: made by hook_on().
struct hook_request {
    uptr target = 0;
    uptr detour = 0;
    detail::hook_state* state = nullptr;
};

template <typename Signature>
class hook_slot;

// One detour site. Each is a constinit global, so its detour is a plain function the game can
// call; while installed, the hook_set that installed it owns it.
template <typename R, typename... Args>
class hook_slot<R(Args...)> final {
public:
    using function = R (*)(Args...);
    using handler = R (*)(function original, Args... args);

    // noexcept for the constinit globals it builds, which may not have a throwing initializer.
    consteval explicit hook_slot(handler body) noexcept
        : m_handler{body} {}

    hook_slot(const hook_slot&) = delete ("the detour is bound to this object's address");
    auto operator=(const hook_slot&) -> hook_slot& = delete ("bound to its address");
    hook_slot(hook_slot&&) = delete ("bound to its address");
    auto operator=(hook_slot&&) -> hook_slot& = delete ("bound to its address");
    ~hook_slot() = default;

    // NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(slot)`.

    // hook_on() spells this; call that instead.
    template <hook_slot& Self>
    static auto request_for(uptr target) -> hook_request {
        return hook_request{
            .target = target,
            .detour = std::bit_cast<uptr>(&detour<Self>),
            .state = &Self.m_state,
        };
    }

private:
    template <hook_slot& Self>
    static auto detour(Args... args) -> R {
        const detail::in_flight_call counted{Self.m_state.in_flight};
        const auto original =
            std::bit_cast<function>(Self.m_state.original.load(std::memory_order_acquire));
        return Self.m_handler(original, args...);
    }

    // NOLINTEND(readability-redundant-parentheses)

    handler m_handler;
    detail::hook_state m_state;
};

// A request to hook target with Slot's handler, by patching the target's first instructions
// (a trampoline keeps the original callable).
template <auto& Slot>
auto hook_on(uptr target) -> hook_request {
    // NOLINTNEXTLINE(readability-redundant-parentheses): instantiated, a reference template argument reads as `(slot)`.
    return std::remove_cvref_t<decltype(Slot)>::template request_for<Slot>(target);
}

// How long removal waits for the hooked code to fall idle before it gives up.
inline constexpr std::chrono::milliseconds unhook_patience{5000};

// Hooks installed together and removed together. Install and remove on one thread only (the
// lifecycle thread): the hooking library is built without thread-safe statics.
class hook_set final {
public:
    // All or nothing: if one target can't be hooked, none stays hooked.
    static auto install(std::span<const hook_request> requests) -> result<hook_set>;

    hook_set(const hook_set&) = delete ("owns the patches");
    auto operator=(const hook_set&) -> hook_set& = delete ("owns the patches");
    hook_set(hook_set&& other) noexcept;
    auto operator=(hook_set&& other) noexcept -> hook_set&;

    // Unpatches every target, then frees the trampolines once no thread can still be in one: every
    // in-flight count is zero and no other thread, frozen to look, stands in this module's image
    // or a trampoline. Until `patience` runs out it keeps looking; then it leaves the trampolines
    // allocated and returns timed_out, and the module must stay loaded. Other threads of this
    // module must have stopped first, or they count as busy.
    auto remove(std::chrono::milliseconds patience) -> result<void>;

    // Removes with unhook_patience if remove() wasn't called; a timeout there leaves the
    // trampolines allocated.
    ~hook_set();

private:
    struct installed;

    explicit hook_set(std::unique_ptr<installed> hooks);

    std::unique_ptr<installed> m_hooks;
};

}
