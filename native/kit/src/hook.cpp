#include <lucent/kit/hook.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <expected>
#include <memory>
#include <span>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <safetyhook/allocator.hpp>
#include <safetyhook/inline_hook.hpp>

#include <lucent/os/address_range.hpp>
#include <lucent/os/frozen_threads.hpp>

namespace lucent::kit {
namespace {

struct entry {
    safetyhook::InlineHook patch;
    detail::hook_state* state = nullptr;
};

auto is_drained(std::span<const entry> entries) -> bool {
    return std::ranges::all_of(entries, [](const entry& hooked) {
        return hooked.state->in_flight.load(std::memory_order_acquire) == 0;
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

// Where a thread must not stand when the trampolines are freed: this module's image (every detour
// and handler is in it) and each trampoline (relocated prologues, and the jump to the detour a far
// target needs). Nothing here may allocate: other threads are frozen and one may hold the heap
// lock.
auto is_anyone_inside(
    const os::frozen_threads& frozen, const os::address_range& image, std::span<const entry> entries
) -> bool {
    return std::ranges::any_of(frozen.instruction_pointers(), [&](uptr where) {
        return os::contains(image, where) || std::ranges::any_of(entries, [&](const entry& hooked) {
            return is_in_trampoline(hooked, where);
        });
    });
}

// The patches are already disabled, so no thread can newly enter a detour or trampoline: once one
// look finds nobody inside, nobody ever will be.
auto is_idle(std::span<const entry> entries, const os::address_range& image) -> bool {
    if (!is_drained(entries)) {
        return false;
    }
    const result<os::frozen_threads> frozen = os::frozen_threads::freeze_others();
    return frozen && is_drained(entries) && !is_anyone_inside(*frozen, image, entries);
}

auto wait_until_idle(std::span<const entry> entries, std::chrono::milliseconds patience)
    -> result<void> {
    const os::address_range image =
        LUCENT_TRY(os::allocation_containing(std::bit_cast<uptr>(&is_drained)));
    const auto deadline = std::chrono::steady_clock::now() + patience;
    while (!is_idle(entries, image)) {
        if (std::chrono::steady_clock::now() >= deadline) {
            return std::unexpected(error{.code = error_code::timed_out});
        }
        Sleep(1);
    }
    return {};
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
};

auto hook_set::install(std::span<const hook_request> requests) -> result<hook_set> {
    auto hooks = std::make_unique<installed>();
    for (const hook_request& request : requests) {
        LUCENT_INVARIANT(request.target != 0 && request.detour != 0 && request.state != nullptr);
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
    hook_set installed_hooks{std::move(hooks)};
    for (entry& hooked : installed_hooks.m_hooks->entries) {
        if (!hooked.patch.enable()) {
            std::ignore = installed_hooks.remove(unhook_patience);
            return std::unexpected(error{.code = error_code::unsupported});
        }
    }
    return installed_hooks;
}

auto hook_set::remove(std::chrono::milliseconds patience) -> result<void> {
    if (!m_hooks) {
        return {};
    }
    disable_all(m_hooks->entries);
    if (const result<void> idle = wait_until_idle(m_hooks->entries, patience); !idle) {
        // Something may still run in a trampoline or return into a detour: keep both, for good.
        std::ignore = m_hooks.release();
        return idle;
    }
    for (const entry& hooked : m_hooks->entries) {
        hooked.state->original.store(0, std::memory_order_release);
    }
    // Destroying the disabled patches frees their trampolines.
    m_hooks.reset();
    return {};
}

hook_set::hook_set(std::unique_ptr<installed> hooks)
    : m_hooks{std::move(hooks)} {}

hook_set::hook_set(hook_set&&) noexcept = default;

auto hook_set::operator=(hook_set&& other) noexcept -> hook_set& {
    if (this != &other) {
        std::ignore = remove(unhook_patience);
        m_hooks = std::move(other.m_hooks);
    }
    return *this;
}

hook_set::~hook_set() {
    std::ignore = remove(unhook_patience);
}

}
