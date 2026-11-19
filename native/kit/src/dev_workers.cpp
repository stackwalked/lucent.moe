#include <string>
#include <string_view>

#include <Windows.h>

#include <lucent/core/fault.hpp>
#include <lucent/core/text.hpp>
#include <lucent/kit/dev_channel.hpp>

#include "dev.hpp"

// Dev builds only: kit's CMakeLists leaves this file out of every other configuration, so worker
// names and their incident text never reach a release image.

namespace lucent::kit::detail {

auto name_thread(void* thread, std::string_view name) -> void {
    const std::wstring wide = to_wide(name);
    // A name is a debugging aid: a thread without one runs the same.
    SetThreadDescription(thread, wide.c_str());
}

auto report_worker_fault(std::string_view name, const fault& caught) -> void {
    dev::report_incident(std::string{"worker "} + std::string{name}, caught);
}

}
