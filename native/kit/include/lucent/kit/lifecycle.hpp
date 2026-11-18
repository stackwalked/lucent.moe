#pragma once

#include <memory>

#include <lucent/kit/boot_info.hpp>

namespace lucent::kit {

// What a target keeps alive while attached. Destroying it detaches: its members' destructors undo
// what attach did (hooks first).
class attachment {
public:
    attachment(const attachment&) = delete ("identity of the attached module");
    auto operator=(const attachment&) -> attachment& = delete ("identity of the attached module");
    attachment(attachment&&) = delete ("identity of the attached module");
    auto operator=(attachment&&) -> attachment& = delete ("identity of the attached module");
    virtual ~attachment() = default;

protected:
    attachment() = default;
};

// Runs on the lifecycle thread, once, between the boot and attach stages.
using attach_fn = auto (*)() -> result<std::unique_ptr<attachment>>;

// Starts the module's lifecycle thread and returns at once. The thread reports each stage to the
// host, attaches the target, runs until the host asks it to unload or goes away, detaches, then
// frees the module. Call once, on the thread the host started the module with.
auto start(const boot_info& info, attach_fn attach) -> result<void>;

}
