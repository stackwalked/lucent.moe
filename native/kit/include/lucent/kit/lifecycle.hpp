#pragma once

#include <memory>
#include <span>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/boot_info.hpp>
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

// Runs on the lifecycle thread, once, between the boot and attach stages. Workers it starts on the
// set (or that the attachment starts later) are stopped before detach, so they must not be needed
// to undo attach. A failed attach drops what it made before the lifecycle stops its workers:
// start them last.
using attach_fn = auto (*)(worker_set& workers) -> result<std::unique_ptr<attachment>>;

// What a target hands the kit to start. The spans are borrowed for the module's lifetime: static
// data.
struct target {
    attach_fn attach = nullptr;
    // The game modules the target's facts name.
    std::span<const game_module> modules;
    // The keys its fact sets may be signed with.
    std::span<const crypto::public_key> trusted;
};

// Copies the boot_info's bundle, starts the module's lifecycle thread and returns at once. The
// thread reports each stage to the host; after boot it applies the bundle to the linked facts (a
// dev build reports the outcome over the dev channel), refuses to go on if a core capability is
// left unavailable (no attach stage), then attaches the target, runs until the
// host asks it to unload or goes away, detaches, and frees the module, unless detach failed: then
// the host sees no unload stage and the module stays loaded, inert. Call once, on the thread the
// host started the module with.
auto start(const boot_info& info, const target& started) -> result<void>;

}
