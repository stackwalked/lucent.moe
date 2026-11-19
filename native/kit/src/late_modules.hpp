#pragma once

#include <span>
#include <stop_token>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::kit::detail {

// Tells a waiting kit worker that the OS loader has loaded a DLL into this process. Registered with
// the loader's DLL notification, whose callback only sets an event: it runs on whatever game thread
// is loading the DLL, under the loader's lock, so it must neither block nor do the work itself.
//
// Notification rather than a worker polling GetModuleHandle: the loader notifies once the image is
// mapped and relocated, before its entry point runs, while a poll could find a module mid-load,
// with its vtables not yet relocated, and reject facts that are right. Neither calls into the game.
class load_signal final {
public:
    static auto watch() -> result<load_signal>;

    load_signal(const load_signal&) = delete ("registered once with the loader");
    auto operator=(const load_signal&) -> load_signal& = delete ("registered once with the loader");
    // The loader holds the event's handle value, which moving keeps.
    load_signal(load_signal&& other) noexcept;
    auto operator=(load_signal&&) -> load_signal& = delete ("registered once with the loader");
    // Unregisters, which waits for a callback under way, so the callback's code may be freed after.
    ~load_signal();

    // Returns once a DLL has loaded since the last return, or once stop is requested, which it sees
    // within stop_patience. Kit workers only.
    auto wait(const std::stop_token& stop) const -> void;

private:
    // ntdll's LdrUnregisterDllNotification; LONG is 32 bits on Windows.
    using unregister_fn = auto(__stdcall*)(void* cookie) -> i32;

    load_signal(os::unique_handle loaded, void* cookie, unregister_fn unregister);

    os::unique_handle m_loaded;
    void* m_cookie = nullptr;
    unregister_fn m_unregister = nullptr;
};

// What the late-module worker needs: the sets still waiting, and what they apply to.
struct late_facts {
    waiting_sets waiting;
    // The target's game modules: static data.
    std::span<const game_module> modules;
    std::span<const fact_record> records;
};

// The late-module worker's body. After every DLL load the signal reports, applies the waiting sets
// whose modules the game has loaded, until none waits or stop is requested. The signal must have
// been watched since before the sets were judged at boot. A dev build reports each outcome.
auto resolve_late_modules(const std::stop_token& stop, const load_signal& signal, late_facts late)
    -> void;

}
