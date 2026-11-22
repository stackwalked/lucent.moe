#pragma once

#include <optional>
#include <string_view>
#include <variant>

#include <lucent/crypto/crypto.hpp>
#include <lucent/launch/channel.hpp>
#include <lucent/os/process.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>

#include "api/server.hpp"
#include "start/game.hpp"

// Starting a product in its game (POST /v1/starts, then its container): the server checks
// everything in one transaction and answers with the release seal and a per-start key; the loader
// verifies the seal under the code key, streams and opens the container, checks its digest against
// the seal, and only then parses and maps it. The module's own hello consumes the start.

namespace lucent::loader {

struct start_request_inputs {
    game_product product;
    wire::channel chosen = wire::channel::stable;
    // This build's release, as the server checks it against the current loader; the all-zero id in
    // a dev build.
    wire::release_id loader_release;
    crypto::public_key code_key{};
    // The highest module seal number this PC has seen for the product and channel: a lower one is
    // an older release served again, refused before anything of it is fetched.
    u64 highest_seen = 0;
};

struct started_module {
    wire::start_id start;
    // The host's end of the session, and the boot_info the module was started with.
    launch::host_channel channel;
    // The seal's number, to raise the highest seen once the start went through.
    u64 seal_number = 0;
};

// The start's seal is numbered below one this PC has seen for the product and channel.
struct stale_release {
    u64 served = 0;
    u64 highest = 0;
};

using start_outcome = std::variant<started_module, wire::refusal, stale_release>;

// Fails as malformed when the seal, the stream or the container doesn't check out, and as
// version_mismatch when the release starts under another boot_info than this loader hands over.
auto start_module(
    server& api,
    std::string_view access_token,
    const os::process& game,
    const start_request_inputs& inputs
) -> result<start_outcome>;

}
