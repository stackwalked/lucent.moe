#include "lease_worker.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <expected>
#include <mutex>
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
            entitlements entitled = LUCENT_TRY(client.open(*reply, sent));
            return opened_lease{.client = std::move(client), .entitled = std::move(entitled)};
        }
    }
}

auto lease_inbox::push(std::vector<std::byte> frame) -> void {
    {
        const std::scoped_lock<std::mutex> held{m_lock};
        if (std::ssize(m_frames) >= max_frames) {
            m_frames.erase(m_frames.begin());
        }
        m_frames.push_back(std::move(frame));
    }
    m_arrived.notify_one();
}

auto lease_inbox::wait(const std::stop_token& stop, std::chrono::nanoseconds timeout)
    -> std::optional<std::vector<std::byte>> {
    std::unique_lock<std::mutex> held{m_lock};
    if (!m_arrived.wait_for(held, stop, timeout, [this] { return !m_frames.empty(); })) {
        return std::nullopt;
    }
    std::vector<std::byte> frame = std::move(m_frames.front());
    m_frames.erase(m_frames.begin());
    return frame;
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
