#include <lucent/kit/hook.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <expected>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <safetyhook/allocator.hpp>
#include <safetyhook/inline_hook.hpp>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/read_access.hpp>
#include <lucent/os/address_range.hpp>
#include <lucent/os/frozen_threads.hpp>

namespace lucent::kit {
namespace {

// A bound on counting a vtable's entries where its memory gives none.
constexpr isize max_vtable_length = 4096;

// A foreign value that didn't hold up: an object that isn't of its class, a slot past its vtable's
// end, a vtable entry that isn't the method a fact says.
constexpr error refused{.code = error_code::malformed};

struct entry {
    safetyhook::InlineHook patch;
    detail::hook_state* state = nullptr;
};

// One object's shadow vtable: its RTTI locator, then a copy of every entry, the hooked ones
// pointing at their detours. The object's vtable pointer points one past the locator, as the real
// one does.
struct shadowed_object {
    uptr object = 0;
    uptr real_vtable = 0;
    std::vector<uptr> shadow;
    std::vector<object_slot> slots;
    // Whether the object's vtable pointer is its shadow now.
    bool is_swapped = false;
    // Whether removal found something else in its vtable pointer, so the shadow must outlive us.
    bool is_kept = false;
};

auto own_memory() -> foreign::memory_source {
    return foreign::memory_source::this_process();
}

auto read_code_pointer(uptr address) -> result<uptr> {
    return foreign::read(own_memory(), foreign::foreign_ptr<uptr>{.address = address});
}

auto is_executable(uptr address) -> bool {
    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQuery(std::bit_cast<const void*>(address), &region, sizeof(region)) == 0) {
        return false;
    }
    constexpr DWORD executable =
        PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY;
    return region.State == MEM_COMMIT && (region.Protect & executable) != 0;
}

// The run of code pointers from the vtable's start, as the slot facts' bound counts it.
auto vtable_entries(uptr vtable) -> std::vector<uptr> {
    std::vector<uptr> entries;
    for (const isize index : std::views::iota(isize{0}, max_vtable_length)) {
        const result<uptr> code =
            read_code_pointer(vtable + (narrow<uptr>(index) * detail::vtable_entry_size));
        if (!code || !is_executable(*code)) {
            break;
        }
        entries.push_back(*code);
    }
    return entries;
}

// One object's vtable pointer, to be swapped from one vtable to another.
struct vtable_swap {
    uptr object = 0;
    uptr from = 0;
    uptr into = 0;
};

// Swaps only if the pointer still holds `from`. Foreign memory, so under contain(); a fault or
// another value leaves it as it was.
auto swap_vtable(vtable_swap swap) -> bool {
    bool is_swapped = false;
    const contained<void> swapped = contain([&] {
        // NOLINTNEXTLINE(performance-no-int-to-ptr): the object is foreign memory, reached by its address.
        const std::atomic_ref<uptr> pointer{*std::bit_cast<uptr*>(swap.object)};
        uptr expected = swap.from;
        is_swapped =
            pointer.compare_exchange_strong(expected, swap.into, std::memory_order_acq_rel);
    });
    return swapped.has_value() && is_swapped;
}

auto check_entry(const entry_check& check) -> result<void> {
    const uptr held = LUCENT_TRY(read_code_pointer(check.entry));
    if (held != check.holds) {
        return std::unexpected(refused);
    }
    return {};
}

auto shadow_of(const object_hook_request& request) -> result<shadowed_object> {
    LUCENT_INVARIANT(request.object != 0 && request.vtable != 0);
    if (request.object % alignof(uptr) != 0) {
        return std::unexpected(refused);
    }
    const uptr vtable = LUCENT_TRY(read_code_pointer(request.object));
    if (vtable != request.vtable) {
        return std::unexpected(refused);
    }
    const std::vector<uptr> entries = vtable_entries(vtable);
    const uptr locator = LUCENT_TRY(read_code_pointer(vtable - detail::vtable_entry_size));
    std::vector<uptr> shadow{locator};
    shadow.insert(shadow.end(), entries.begin(), entries.end());
    for (const object_slot& slot : request.slots) {
        LUCENT_INVARIANT(slot.detour != 0 && slot.state != nullptr);
        if (slot.index < 0 || slot.index >= std::ssize(entries)) {
            return std::unexpected(refused);
        }
        const auto position = narrow<usize>(slot.index);
        slot.state->original.store(entries.at(position), std::memory_order_release);
        shadow.at(position + 1) = slot.detour;
    }
    return shadowed_object{
        .object = request.object,
        .real_vtable = vtable,
        .shadow = std::move(shadow),
        .slots = request.slots,
        .is_swapped = false,
        .is_kept = false,
    };
}

auto shadow_vtable(const shadowed_object& shadowed) -> uptr {
    return std::bit_cast<uptr>(shadowed.shadow.data()) + sizeof(uptr);
}

// The shadow stays where something else's vtable pointer may lead through it: its hooked slots get
// the real entries back, so a call routed through it reaches the game's code, not a detour that
// is about to go away.
auto unhook_in_place(shadowed_object& shadowed) -> void {
    for (const object_slot& slot : shadowed.slots) {
        const std::atomic_ref<uptr> held{shadowed.shadow.at(narrow<usize>(slot.index) + 1)};
        held.store(slot.state->original.load(std::memory_order_acquire), std::memory_order_release);
    }
}

auto is_drained(std::span<detail::hook_state* const> states) -> bool {
    return std::ranges::all_of(states, [](const detail::hook_state* state) {
        return state->in_flight.load(std::memory_order_acquire) == 0;
    });
}

auto is_in_trampoline(const entry& hooked, uptr where) -> bool {
    const safetyhook::Allocation& trampoline = hooked.patch.trampoline();
    return os::contains(
        os::address_range{
            .begin = trampoline.address(),
            .end = trampoline.address() + trampoline.size(),
        },
        where
    );
}

// What removal waits on: every hooked state, and where no thread may stand.
struct busy_parts {
    std::span<const entry> entries;
    std::span<detail::hook_state* const> states;
    os::address_range image;
};

// Where a thread must not stand when the trampolines are freed: this module's image (every detour
// and handler is in it) and each trampoline (relocated prologues, and the jump to the detour a far
// target needs). Nothing here may allocate: other threads are frozen and one may hold the heap
// lock.
auto is_anyone_inside(const os::frozen_threads& frozen, const busy_parts& busy) -> bool {
    return std::ranges::any_of(frozen.instruction_pointers(), [&](uptr where) {
        return os::contains(busy.image, where)
               || std::ranges::any_of(busy.entries, [&](const entry& hooked) {
                      return is_in_trampoline(hooked, where);
                  });
    });
}

// The patches are already disabled and the shadows withdrawn, so no thread can newly enter a
// detour or trampoline: once one look finds nobody inside, nobody ever will be.
auto is_idle(const busy_parts& busy) -> bool {
    if (!is_drained(busy.states)) {
        return false;
    }
    const result<os::frozen_threads> frozen = os::frozen_threads::freeze_others();
    return frozen && is_drained(busy.states) && !is_anyone_inside(*frozen, busy);
}

auto disable_all(std::vector<entry>& entries) -> void {
    for (entry& hooked : entries) {
        // A disable that fails leaves a target patched into a detour that's about to go away.
        const auto disabled = hooked.patch.disable();
        LUCENT_INVARIANT(disabled.has_value());
    }
}

}

struct hook_set::installed {
    std::vector<entry> entries;
    std::vector<shadowed_object> objects;
};

namespace {

auto states_of(std::span<const entry> entries, std::span<const shadowed_object> objects)
    -> std::vector<detail::hook_state*> {
    std::vector<detail::hook_state*> all;
    for (const entry& hooked : entries) {
        all.push_back(hooked.state);
    }
    for (const shadowed_object& shadowed : objects) {
        for (const object_slot& slot : shadowed.slots) {
            all.push_back(slot.state);
        }
    }
    return all;
}

// Gives the object its vtable pointer back if it still holds the shadow; otherwise the shadow is
// kept, its slots unhooked in place.
auto withdraw(shadowed_object& shadowed) -> void {
    if (!shadowed.is_swapped) {
        return;
    }
    shadowed.is_swapped = false;
    const vtable_swap back{
        .object = shadowed.object,
        .from = shadow_vtable(shadowed),
        .into = shadowed.real_vtable,
    };
    if (!swap_vtable(back)) {
        shadowed.is_kept = true;
        unhook_in_place(shadowed);
    }
}

}

auto hook_set::install(
    std::span<const hook_request> requests, std::span<const object_hook_request> objects
) -> result<hook_set> {
    auto hooks = std::make_unique<installed>();
    for (const hook_request& request : requests) {
        LUCENT_INVARIANT(request.target != 0 && request.detour != 0 && request.state != nullptr);
        if (request.check) {
            LUCENT_TRY(check_entry(*request.check));
        }
        auto created = safetyhook::InlineHook::create(
            std::bit_cast<void*>(request.target),
            std::bit_cast<void*>(request.detour),
            safetyhook::InlineHook::StartDisabled
        );
        if (!created) {
            // Nothing is enabled yet; the patches made so far are freed with `hooks`.
            return std::unexpected(error{.code = error_code::unsupported});
        }
        request.state->original.store(
            std::bit_cast<uptr>(created->original<void*>()), std::memory_order_release
        );
        hooks->entries.push_back(entry{.patch = std::move(*created), .state = request.state});
    }
    for (const object_hook_request& request : objects) {
        LUCENT_INVARIANT(
            !std::ranges::contains(hooks->objects, request.object, &shadowed_object::object)
        );
        hooks->objects.push_back(LUCENT_TRY(shadow_of(request)));
    }
    hook_set installed_hooks{std::move(hooks)};
    installed& made = *installed_hooks.m_hooks;
    for (entry& hooked : made.entries) {
        if (!hooked.patch.enable()) {
            std::ignore = installed_hooks.remove(unhook_patience);
            return std::unexpected(error{.code = error_code::unsupported});
        }
    }
    for (shadowed_object& shadowed : made.objects) {
        const vtable_swap onto{
            .object = shadowed.object,
            .from = shadowed.real_vtable,
            .into = shadow_vtable(shadowed),
        };
        if (!swap_vtable(onto)) {
            std::ignore = installed_hooks.remove(unhook_patience);
            return std::unexpected(refused);
        }
        shadowed.is_swapped = true;
    }
    return installed_hooks;
}

auto hook_set::install(std::span<const hook_request> requests) -> result<hook_set> {
    return install(requests, {});
}

auto hook_set::remove(std::chrono::milliseconds patience) -> result<void> {
    if (!m_hooks) {
        return {};
    }
    disable_all(m_hooks->entries);
    for (shadowed_object& shadowed : m_hooks->objects) {
        withdraw(shadowed);
    }
    const std::vector<detail::hook_state*> states = states_of(m_hooks->entries, m_hooks->objects);
    const os::address_range image =
        LUCENT_TRY(os::allocation_containing(std::bit_cast<uptr>(&is_drained)));
    const busy_parts busy{.entries = m_hooks->entries, .states = states, .image = image};
    const auto deadline = std::chrono::steady_clock::now() + patience;
    while (!is_idle(busy)) {
        if (std::chrono::steady_clock::now() >= deadline) {
            // Something may still run in a trampoline, return into a detour or read a shadow:
            // keep them all, for good.
            std::ignore = m_hooks.release();
            return std::unexpected(error{.code = error_code::timed_out});
        }
        Sleep(1);
    }
    for (detail::hook_state* const state : states) {
        state->original.store(0, std::memory_order_release);
    }
    for (shadowed_object& shadowed : m_hooks->objects) {
        if (shadowed.is_kept) {
            // Something else's vtable pointer may still lead through it.
            std::ignore = std::make_unique<std::vector<uptr>>(std::move(shadowed.shadow)).release();
        }
    }
    // Destroying the disabled patches frees their trampolines; the restored shadows go with them.
    m_hooks.reset();
    return {};
}

hook_set::hook_set(std::unique_ptr<installed> hooks)
    : m_hooks{std::move(hooks)} {}

hook_set::hook_set(hook_set&&) noexcept = default;

// A throw in remove() is bad_alloc; terminating is the right end for it.
// NOLINTNEXTLINE(bugprone-exception-escape)
auto hook_set::operator=(hook_set&& other) noexcept -> hook_set& {
    if (this != &other) {
        std::ignore = remove(unhook_patience);
        m_hooks = std::move(other.m_hooks);
    }
    return *this;
}

// As operator=.
// NOLINTNEXTLINE(bugprone-exception-escape)
hook_set::~hook_set() {
    std::ignore = remove(unhook_patience);
}

}
