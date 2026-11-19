#pragma once

#include <string_view>

#include <lucent/core/fault.hpp>
#include <lucent/kit/dev_build.hpp>

// A release image carries no dev text, so a release build that reaches for the channel fails here
// rather than compiling it to nothing. Its definitions are compiled into dev builds only.
static_assert(
    lucent::kit::is_dev_build,
    "the dev channel is dev-only: include it from sources only dev builds compile"
);

namespace lucent::kit::dev {

// Text from module to host over the session, rendered by loader-dev. Any thread. While no session
// is open (before boot, after unload, in tests) the text goes nowhere; a send to a host that has
// gone away is dropped too.
auto send_text(std::string_view line) -> void;

// A fault contain() caught, for the host to see; `what` names the code that was running.
auto report_incident(std::string_view what, const fault& caught) -> void;

}
