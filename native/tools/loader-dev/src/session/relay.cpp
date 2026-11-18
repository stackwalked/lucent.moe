#include "session/relay.hpp"

#include <print>
#include <string_view>

#include <lucent/core/match.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>

#include "cli/describe.hpp"

namespace lucent::loader_dev {
namespace {

auto name_of(kit::stage reached) -> std::string_view {
    switch (reached) {
    case kit::stage::boot:
        return "boot";
    case kit::stage::attach:
        return "attach";
    case kit::stage::run:
        return "run";
    case kit::stage::detach:
        return "detach";
    case kit::stage::unload:
        return "unload";
    }
    return "unknown";
}

auto print_message(const kit::session_message& message) -> void {
    match(
        message,
        [](const kit::log_line& line) { std::println("module: {}", line.text); },
        [](const kit::stage_reached& reached) {
            std::println("stage: {}", name_of(reached.reached));
        },
        [](const kit::unload_request&) { std::println("module asked the host to unload?"); }
    );
}

}

auto relay(kit::session& channel) -> void {
    while (true) {
        const result<kit::session_message> received = channel.receive();
        if (!received) {
            std::println("channel closed: {}", describe(received.error()));
            return;
        }
        print_message(*received);
    }
}

}
