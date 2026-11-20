#pragma once

#include <memory>
#include <span>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::kit {

// What a target keeps alive while attached.
class attachment {
public:
    attachment(const attachment&) = delete ("identity of the attached module");
    auto operator=(const attachment&) -> attachment& = delete ("identity of the attached module");
    attachment(attachment&&) = delete ("identity of the attached module");
    auto operator=(attachment&&) -> attachment& = delete ("identity of the attached module");
    virtual ~attachment() = default;

    // Undoes attach, on the lifecycle thread. A failure means a thread may still run this
    // module's code, so the lifecycle leaves the module loaded instead of freeing it.
    virtual auto detach() -> result<void> = 0;

protected:
    attachment() = default;
};

// Runs on the lifecycle thread, once, after the resolve stage. Workers it starts on the set (or
// that the attachment starts later) are stopped before detach, so they must not be needed to undo
// attach. A failed attach drops what it made before the lifecycle stops its workers: start them
// last. The token opens foreign access: the target hands it to its domains, never to a feature.
using attach_fn = auto (*)(worker_set& workers, const domain_token& opens)
    -> result<std::unique_ptr<attachment>>;

// What a target hands the kit to start. The spans are borrowed for the module's lifetime: static
// data.
struct target {
    attach_fn attach = nullptr;
    // The game modules the target's facts name.
    std::span<const game_module> modules;
    // The keys its fact sets may be signed with.
    std::span<const crypto::public_key> trusted;
};

// Copies the boot_info's bundle, registers a mapped image's .pdata, starts the module's lifecycle
// thread and returns at once. The thread reports each stage to the host. Between boot and attach
// it runs the resolve stage, which the host doesn't see: it applies the bundle to the linked facts
// (a dev build reports the outcome over the dev channel) and judges the core capabilities. One
// that failed refuses the start (start_refused, then no attach stage); one waiting only for a
// module the game hasn't loaded lets the start go on, its features unavailable, and ends the
// session with start_refused if it fails once the module loads. Then it attaches
// the target, runs until the host asks it to unload, the host goes away or a late core capability
// fails, detaches, and frees the module, unless detach failed: then the host sees no unload stage
// and the module stays loaded, inert. Call once, on the thread the host started the module with.
auto start(const boot_info& info, const target& started) -> result<void>;

}
