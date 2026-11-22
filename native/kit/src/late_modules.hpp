#pragma once

#include <chrono>
#include <span>
#include <stop_token>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/os/unique_handle.hpp>

#include "data_client.hpp"
#include "frame_inbox.hpp"
#include "random.hpp"
#include "session_end.hpp"

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

// What the late-module worker needs: the sets and core capabilities still waiting, and what they
// apply to.
struct late_facts {
    waiting_sets waiting;
    // Core capabilities that were unavailable only for a module not loaded yet.
    std::vector<declared_capability> waiting_core;
    // The indices of the target's game modules that weren't loaded at boot: with a data route,
    // the server is asked for each one's set once it loads.
    std::vector<u8> unasked;
    // The target's game modules: static data.
    std::span<const game_module> modules;
    std::span<const fact_record> records;
    // The keys a late set may be signed with: static data.
    std::span<const crypto::public_key> trusted;
};

// How long an asked-for set may take to come back: the loader's own patience for one call (10 s
// to connect, 30 s to receive, loader/src/http/client.cpp), twice for a proof retried with the
// server's clock, and room for a renewal relayed ahead of it.
inline constexpr std::chrono::seconds data_patience{90};

// The data route as the late-module worker uses it (release builds). Every pointer outlives the
// worker; the inbox is fed by the lifecycle thread with the data frames the host relays.
struct data_link {
    data_client* client = nullptr;
    frame_inbox* inbox = nullptr;
    session* channel = nullptr;
    const clock* time = nullptr;
    random_source* random = nullptr;
};

// What the lifecycle hands the late-module worker. The signal and the session end outlive it; the
// session end is null only when no core capability waits, the data link null in dev builds and
// without a session.
struct late_worker {
    const load_signal* signal = nullptr;
    session_end* ending = nullptr;
    const data_link* data = nullptr;
    late_facts facts;
};

// The late-module worker's body. After every DLL load the signal reports, asks the server once for
// the sets of the unasked modules that have loaded since (with a data link: one request per
// wake, which an unreachable server or a refusal leaves unanswered, their capabilities then
// unavailable), applies the waiting sets whose modules the game has loaded, then judges the waiting
// core capabilities again: one that failed once its modules loaded ends the session (decided: a
// late core module waits, and only its failure ends the session). Returns once nothing waits or is
// left to ask for, once it ended the session, or once stop is requested. The signal must have been
// watched since before the sets were judged at boot. A dev build reports each outcome.
auto resolve_late_modules(const std::stop_token& stop, late_worker worker) -> void;

}
