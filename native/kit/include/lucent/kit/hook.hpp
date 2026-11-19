#pragma once

#include <atomic>
#include <bit>
#include <chrono>
#include <concepts>
#include <memory>
#include <optional>
#include <span>
#include <type_traits>
#include <vector>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::kit {

namespace detail {

// One hooked function's shared state: the original to call, and the calls inside its detour now.
struct hook_state {
    std::atomic<uptr> original{0};
    std::atomic<i32> in_flight{0};
};

}

template <typename Signature>
class hook_access;

// One call of hooked code, made by the detour each time and alive until that call returns: it
// counts the call as in flight, so removal waits it out, and reaches the original. The detour
// holds it outside the handler, whose foreign work runs inside contain(), so a contained fault
// can't skip its destructor. Borrowed by the handler for its call only.
template <typename R, typename... Args>
class hook_access<R(Args...)> final {
public:
    hook_access(const hook_access&) = delete ("counts one call");
    auto operator=(const hook_access&) -> hook_access& = delete ("counts one call");
    hook_access(hook_access&&) = delete ("counts one call");
    auto operator=(hook_access&&) -> hook_access& = delete ("counts one call");

    ~hook_access() {
        m_state->in_flight.fetch_sub(1, std::memory_order_release);
    }

    // What the hook replaced: the trampoline of an inline hook, the real entry of a shadowed slot.
    auto original(Args... args) const -> R {
        return std::bit_cast<R (*)(Args...)>(m_original)(args...);
    }

private:
    template <typename Signature>
    friend class hook_slot;

    explicit hook_access(detail::hook_state& state)
        : m_state{&state}
        , m_original{entered(state)} {}

    // Counts the call before reading the original, so removal, which clears the original only once
    // nothing is counted, can't clear it under a counted call.
    static auto entered(detail::hook_state& state) -> uptr {
        state.in_flight.fetch_add(1, std::memory_order_acq_rel);
        return state.original.load(std::memory_order_acquire);
    }

    detail::hook_state* m_state;
    uptr m_original;
};

// What install checks before it patches: the code pointer at `entry` must be `holds`. A hook
// request from a method fact that is also a vtable fact's slot carries one, so a vtable whose slot
// moved refuses the hook instead of hooking the wrong function.
struct entry_check {
    uptr entry = 0;
    uptr holds = 0;
};

// What hook_set needs to hook one function by patching its first instructions (a trampoline keeps
// the original callable): made by hook_on().
struct hook_request {
    uptr target = 0;
    uptr detour = 0;
    detail::hook_state* state = nullptr;
    std::optional<entry_check> check;
};

// One slot of a shadowed vtable, untyped.
struct object_slot {
    isize index = 0;
    uptr detour = 0;
    detail::hook_state* state = nullptr;
};

// A slot hook typed by the class whose vtable it shadows: made by hook_on_slot(), given to
// hook_object() for an object of that class.
template <foreign::addressable Class>
struct slot_hook {
    object_slot slot;
};

// What hook_set needs to shadow one object's vtable: made by hook_object(). The object must be one
// that lives as long as the module (a game singleton): its vtable pointer is ours until removal
// puts the real one back, and an object freed meanwhile would be written after its free.
struct object_hook_request {
    uptr object = 0;
    // The vtable the object must have when the hook is installed: its class.
    uptr vtable = 0;
    std::vector<object_slot> slots;
};

template <typename Signature>
class hook_slot;

// One detour site. Each is a constinit global, so its detour is a plain function the game can
// call; while installed, the hook_set that installed it owns it.
template <typename R, typename... Args>
class hook_slot<R(Args...)> final {
public:
    using signature = R(Args...);
    using handler = R (*)(const hook_access<R(Args...)>& call, Args... args);

    // noexcept for the constinit globals it builds, which may not have a throwing initializer.
    consteval explicit hook_slot(handler body) noexcept
        : m_handler{body} {}

    hook_slot(const hook_slot&) = delete ("the detour is bound to this object's address");
    auto operator=(const hook_slot&) -> hook_slot& = delete ("bound to its address");
    hook_slot(hook_slot&&) = delete ("bound to its address");
    auto operator=(hook_slot&&) -> hook_slot& = delete ("bound to its address");
    ~hook_slot() = default;

    // NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(slot)`.

    // hook_on() and hook_on_slot() spell these; call those instead.
    template <hook_slot& Self>
    static auto request_for(uptr target) -> hook_request {
        return hook_request{
            .target = target,
            .detour = std::bit_cast<uptr>(&detour<Self>),
            .state = &Self.m_state,
            .check = std::nullopt,
        };
    }

    template <hook_slot& Self>
    static auto slot_for(isize index) -> object_slot {
        return object_slot{
            .index = index,
            .detour = std::bit_cast<uptr>(&detour<Self>),
            .state = &Self.m_state,
        };
    }

private:
    template <hook_slot& Self>
    static auto detour(Args... args) -> R {
        const hook_access<R(Args...)> call{Self.m_state};
        return Self.m_handler(call, args...);
    }

    // NOLINTEND(readability-redundant-parentheses)

    handler m_handler;
    detail::hook_state m_state;
};

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(slot)`.

template <auto& Slot>
using hook_slot_type = std::remove_cvref_t<decltype(Slot)>;

// Whether a hook's handler has exactly the signature a method or slot fact declares.
template <auto& Slot, const auto& Fact>
concept hooks_as = std::same_as<
    typename hook_slot_type<Slot>::signature,
    typename std::remove_cvref_t<decltype(Fact)>::signature>;

// A request to hook target with Slot's handler: for code no fact names, such as an OS interface's.
template <auto& Slot>
auto hook_on(uptr target) -> hook_request {
    return hook_slot_type<Slot>::template request_for<Slot>(target);
}

// A request to hook a method fact's function. Only once the method's capability is available.
template <auto& Slot, const auto& Method>
    requires(is_method_fact<fact_type<Method>> && hooks_as<Slot, Method>)
auto hook_on() -> hook_request {
    return hook_slot_type<Slot>::template request_for<Slot>(Method.address());
}

// A request to hook a method fact's function that a vtable fact also holds at a slot fact: install
// refuses it unless the vtable's entry at the slot is the method.
template <auto& Slot, const auto& Method, const auto& Vtable, const auto& Index>
    requires(
        is_method_fact<fact_type<Method>>
        && is_vtable_fact<fact_type<Vtable>>
        && is_slot_fact<fact_type<Index>>
        && std::same_as<class_of<Vtable>, class_of<Index>>
        && hooks_as<Slot, Method>
        && hooks_as<Slot, Index>
    )
auto hook_on() -> hook_request {
    hook_request request = hook_slot_type<Slot>::template request_for<Slot>(Method.address());
    request.check = entry_check{
        .entry = Vtable.address() + (static_cast<uptr>(Index.index()) * detail::vtable_entry_size),
        .holds = Method.address(),
    };
    return request;
}

// One slot of a vtable to shadow with Slot's handler, by its index: for vtables no fact names.
template <auto& Slot>
auto hook_on_slot(isize index) -> object_slot {
    return hook_slot_type<Slot>::template slot_for<Slot>(index);
}

// One slot of a vtable to shadow with Slot's handler, by its slot fact.
template <auto& Slot, const auto& Index>
    requires(is_slot_fact<fact_type<Index>> && hooks_as<Slot, Index>)
auto hook_on_slot() -> slot_hook<class_of<Index>> {
    return {.slot = hook_slot_type<Slot>::template slot_for<Slot>(Index.index())};
}

// A request to give object a shadow vtable: a copy of its class's, the given slots pointing at
// their detours. The real vtable is never patched (that would miss devirtualized and direct calls
// alike, and touch every other object of the class). Install refuses an object whose vtable isn't
// the fact's.
template <const auto& Vtable>
    requires is_vtable_fact<fact_type<Vtable>>
auto hook_object(
    foreign::foreign_ptr<class_of<Vtable>> object,
    std::span<const slot_hook<class_of<Vtable>>> slots
) -> object_hook_request {
    object_hook_request request{.object = object.address, .vtable = Vtable.address(), .slots = {}};
    for (const slot_hook<class_of<Vtable>>& hooked : slots) {
        request.slots.push_back(hooked.slot);
    }
    return request;
}

// NOLINTEND(readability-redundant-parentheses)

// How long removal waits for the hooked code to fall idle before it gives up.
inline constexpr std::chrono::milliseconds unhook_patience{5000};

// Hooks installed together and removed together. Install and remove on one thread only (the
// lifecycle thread): the hooking library is built without thread-safe statics.
class hook_set final {
public:
    // All or nothing: if one function can't be hooked, one check fails, or one object isn't of its
    // class, none stays hooked.
    static auto install(
        std::span<const hook_request> requests, std::span<const object_hook_request> objects
    ) -> result<hook_set>;
    static auto install(std::span<const hook_request> requests) -> result<hook_set>;

    hook_set(const hook_set&) = delete ("owns the patches");
    auto operator=(const hook_set&) -> hook_set& = delete ("owns the patches");
    hook_set(hook_set&& other) noexcept;
    auto operator=(hook_set&& other) noexcept -> hook_set&;

    // Unpatches every function and gives every shadowed object its vtable pointer back, if that
    // pointer is still its shadow (read under contain()); one that something else replaced keeps
    // it, and its shadow stays allocated with the real entries back in its slots. Then frees the
    // trampolines and shadows once no thread can still be in one: every in-flight count is zero
    // and no other thread, frozen to look, stands in this module's image or a trampoline. Until
    // `patience` runs out it keeps looking; then it leaves both allocated and returns timed_out,
    // and the module must stay loaded. Every kit worker must have been joined first (the lifecycle
    // stops them before detach): until then, one running counts as busy.
    auto remove(std::chrono::milliseconds patience) -> result<void>;

    // Removes with unhook_patience if remove() wasn't called; a timeout there leaves the
    // trampolines and shadows allocated.
    ~hook_set();

private:
    struct installed;

    explicit hook_set(std::unique_ptr<installed> hooks);

    std::unique_ptr<installed> m_hooks;
};

}
