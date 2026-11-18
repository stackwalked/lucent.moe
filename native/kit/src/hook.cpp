#include <lucent/kit/hook.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <expected>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <safetyhook/inline_hook.hpp>

namespace lucent::kit {
namespace {

struct entry {
    safetyhook::InlineHook patch;
    detail::hook_state* state = nullptr;
};

// A thread can be inside a detour's first instructions, not yet counted, at the moment its target
// is unpatched. Waiting this long after the counts drain lets it show up in them. Clean unload
// replaces this with a check made while every other thread is frozen (wishlist: Kit).
constexpr DWORD uncounted_grace_ms = 50;

auto is_drained(std::span<const entry> entries) -> bool {
    return std::ranges::all_of(entries, [](const entry& hooked) {
        return hooked.state->in_flight.load(std::memory_order_acquire) == 0;
    });
}

auto wait_until_drained(std::span<const entry> entries) -> void {
    while (!is_drained(entries)) {
        Sleep(1);
    }
}

auto remove(std::vector<entry>& entries) -> void {
    for (entry& hooked : entries) {
        // A disable that fails leaves a target patched into a detour that's about to go away.
        const auto disabled = hooked.patch.disable();
        LUCENT_INVARIANT(disabled.has_value());
    }
    wait_until_drained(entries);
    Sleep(uncounted_grace_ms);
    wait_until_drained(entries);
    for (const entry& hooked : entries) {
        hooked.state->original.store(0, std::memory_order_release);
    }
    // Destroying the disabled patches frees their trampolines.
    entries.clear();
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
    for (entry& hooked : hooks->entries) {
        if (!hooked.patch.enable()) {
            remove(hooks->entries);
            return std::unexpected(error{.code = error_code::unsupported});
        }
    }
    return hook_set{std::move(hooks)};
}

hook_set::hook_set(std::unique_ptr<installed> hooks)
    : m_hooks{std::move(hooks)} {}

hook_set::hook_set(hook_set&&) noexcept = default;

auto hook_set::operator=(hook_set&& other) noexcept -> hook_set& {
    if (this != &other) {
        if (m_hooks) {
            remove(m_hooks->entries);
        }
        m_hooks = std::move(other.m_hooks);
    }
    return *this;
}

hook_set::~hook_set() {
    if (m_hooks) {
        remove(m_hooks->entries);
    }
}

}
