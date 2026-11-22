#include "lease_worker.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <expected>
#include <optional>
#include <stop_token>
#include <tuple>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/own_release.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>

#include "lease_client.hpp"
#include "own_lease_key.hpp"
#include "random.hpp"
#include "release.hpp"

namespace lucent::kit::detail {
namespace {

auto wire_kind_of(image_kind kind) -> wire::image_kind {
    switch (kind) {
    case image_kind::loaded:
        return wire::image_kind::loaded;
    case image_kind::mapped:
        return wire::image_kind::mapped;
    }
    LUCENT_UNREACHABLE();
}

}

auto own_identity(const boot_info& info, const own_image& image) -> lease_identity {
    const std::optional<crypto::public_key> lease_key = own_lease_key();
    const std::optional<wire::release_id> release = own_release();
    // A Release build has both: CMake refuses to configure one without them.
    LUCENT_INVARIANT(lease_key.has_value() && release.has_value());
    return lease_identity{
        .lease_key = *lease_key,
        .release = *release,
        .boot = wire::boot_report{
            .boot_info_version = info.version,
            .kind = wire_kind_of(image.kind),
            .image_base = image.base,
            .image_size = narrow<u32>(image.size),
        },
    };
}

auto open_lease(
    session& channel, const lease_identity& identity, const clock& time, random_source& random
) -> result<opened_lease> {
    lease_client client = LUCENT_TRY(lease_client::create(identity, random));
    const clock::time_point sent = time.now();
    LUCENT_TRY(
        channel.send(server_request{.route = server_route::session, .body = client.hello()})
    );
    while (true) {
        const session_message received = LUCENT_TRY(channel.receive());
        if (is_unload_request(received)) {
            return std::unexpected(error{.code = error_code::closed});
        }
        if (const std::optional<std::vector<std::byte>> reply =
                reply_body(received, server_route::session);
            reply) {
            session_opening opening = LUCENT_TRY(client.open(*reply, sent));
            return opened_lease{
                .client = std::move(client),
                .entitled = std::move(opening.entitled),
                .data = std::move(opening.data),
                .bundle = std::move(opening.first_data.bundle_bytes),
            };
        }
    }
}

auto run_lease(const std::stop_token& stop, lease_run run) -> void {
    bool is_lapsed = false;
    while (!stop.stop_requested()) {
        const clock::time_point now = run.time->now();
        switch (run.client.standing(now)) {
        case lease_standing::held:
            break;
        case lease_standing::lapsed:
            if (!is_lapsed) {
                run.features->request({lapse_lease{}});
                is_lapsed = true;
            }
            break;
        case lease_standing::ended:
            // Returns once the lifecycle stops the workers.
            run.ending->request(stop, wire::refusal_code::session_ended);
            return;
        }
        if (run.client.is_renewal_due(now)) {
            const result<std::vector<std::byte>> renewal = run.client.renewal(now, *run.random);
            // An unsent renewal is retried at the next interval; a host that's gone ends the
            // session through the lifecycle's own read.
            if (renewal) {
                std::ignore = run.channel->send(
                    server_request{.route = server_route::lease, .body = *renewal}
                );
            }
        }
        const std::chrono::nanoseconds until =
            std::max(run.client.next_change(now) - now, std::chrono::nanoseconds{0});
        const std::optional<std::vector<std::byte>> frame = run.inbox->wait(stop, until);
        if (!frame) {
            continue;
        }
        // A frame that doesn't check out is the host's or the network's noise: dropped.
        const result<entitlements> granted = run.client.accept(*frame);
        if (!granted) {
            continue;
        }
        std::vector<registry_change> changes;
        if (*granted != run.entitled) {
            changes.emplace_back(replace_entitlements{.entitled = *granted});
        }
        if (is_lapsed) {
            changes.emplace_back(resume_lease{});
        }
        if (!changes.empty()) {
            run.features->request(std::move(changes));
        }
        run.entitled = *granted;
        is_lapsed = false;
    }
}

}
