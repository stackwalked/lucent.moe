#include "../src/lease_client.hpp"

#include <chrono>
#include <cstddef>
#include <expected>
#include <initializer_list>
#include <memory>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/session.hpp>

#include "../src/data_client.hpp"
#include "../src/random.hpp"

// The lease client against a stand-in server built from wire's own signing and sealing, on a
// clock that only moves when a test says so.

namespace lucent::kit::detail {
namespace {

using std::chrono_literals::operator""s;

// splitmix64: deterministic bytes, so a failing run replays exactly.
class seeded_random final : public random_source {
public:
    explicit seeded_random(u64 seed)
        : m_state{seed} {}

    auto fill(std::span<std::byte> out) -> result<void> override {
        for (std::byte& each : out) {
            m_state += 0x9e37'79b9'7f4a'7c15ULL;
            u64 mixed = m_state;
            mixed = (mixed ^ (mixed >> 30U)) * 0xbf58'476d'1ce4'e5b9ULL;
            mixed = (mixed ^ (mixed >> 27U)) * 0x94d0'49bb'1331'11ebULL;
            each = std::byte{static_cast<u8>(mixed ^ (mixed >> 31U))};
        }
        return {};
    }

private:
    u64 m_state = 0;
};

template <typename Id>
auto id_of(u8 fill) -> Id {
    Id id;
    id.bytes.fill(std::byte{fill});
    return id;
}

auto seed_of(u8 fill) -> crypto::seed {
    crypto::seed material{};
    material.fill(std::byte{fill});
    return material;
}

constexpr clock::time_point start{};
constexpr std::chrono::milliseconds lease_duration{60'000};

// What the server does for a session, as platform/server/src/delivery/runtime/sessions.ts does it,
// minus the database.
class stand_in_server final {
public:
    // Choices a test makes to see the client refuse them.
    struct reply_options {
        std::optional<wire::release_id> release;
        std::optional<wire::module_nonce> nonce;
        bool is_signed_by_another_key = false;
        // Seals the first data under the lease route's key, as a server mixing routes up would.
        bool is_data_under_lease_key = false;
    };

    auto reply_to(std::span<const std::byte> hello_bytes, const reply_options& options)
        -> std::vector<std::byte> {
        const result<wire::session_hello> hello = wire::decode_session_hello(hello_bytes);
        REQUIRE(hello.has_value());
        const crypto::exchange_key server_key = crypto::exchange_key::from_seed(seed_of(9));
        result<crypto::secret_key> shared = server_key.shared_secret(hello->module_key);
        REQUIRE(shared.has_value());
        m_keys = std::make_unique<wire::session_keys>(wire::derive_session_keys(
            *shared,
            wire::exchange_halves{
                .module_key = hello->module_key,
                .server_key = server_key.public_part(),
            }
        ));
        const crypto::signing_key other = crypto::signing_key::from_seed(seed_of(8));
        const crypto::signing_key& signer = options.is_signed_by_another_key ? other : m_lease_key;
        const wire::session_exchange exchange = wire::sign_session_exchange(
            wire::session_exchange{
                .session = m_session,
                .module_key = hello->module_key,
                .nonce = hello->nonce,
                .server_key = server_key.public_part(),
                .signature = {},
            },
            signer
        );
        const wire::lease first = lease_of(
            1, options.nonce.value_or(hello->nonce), options.release.value_or(hello->release)
        );
        return wire::encode_session_reply(
            wire::session_reply{
                .exchange = exchange,
                .first_lease = sealed(first),
                .first_data = sealed_data(
                    options.is_data_under_lease_key ? m_keys->lease.server_to_module
                                                    : m_keys->data.server_to_module,
                    m_first_bundle
                ),
            }
        );
    }

    // The data response to the request in this frame, and the request as the server read it.
    struct data_answer {
        wire::frame_header request_header;
        wire::data_request request;
        std::vector<std::byte> response;
    };

    auto data_for(std::span<const std::byte> request_frame, std::vector<std::byte> bundle)
        -> data_answer {
        const result<wire::frame> frame = wire::decode_frame(request_frame);
        REQUIRE(frame.has_value());
        REQUIRE(m_keys != nullptr);
        const result<crypto::secret_bytes> plain =
            wire::open_frame(m_keys->data.module_to_server, *frame);
        REQUIRE(plain.has_value());
        const result<wire::data_request> request = wire::decode_data_request(plain->as_bytes());
        REQUIRE(request.has_value());
        return data_answer{
            .request_header = frame->header,
            .request = *request,
            .response = wire::encode_frame(sealed_data(m_keys->data.server_to_module, bundle)),
        };
    }

    // The next lease, for the renewal in this frame.
    auto lease_for(std::span<const std::byte> renewal_frame) -> std::vector<std::byte> {
        const result<wire::frame> frame = wire::decode_frame(renewal_frame);
        REQUIRE(frame.has_value());
        REQUIRE(m_keys != nullptr);
        const result<crypto::secret_bytes> plain =
            wire::open_frame(m_keys->lease.module_to_server, *frame);
        REQUIRE(plain.has_value());
        const result<wire::lease_renewal> renewal = wire::decode_lease_renewal(plain->as_bytes());
        REQUIRE(renewal.has_value());
        return wire::encode_frame(sealed(lease_of(renewal->sequence, renewal->nonce, m_release)));
    }

    // What the next session reply's first data carries; opaque to the client.
    auto carry_first(std::vector<std::byte> bundle) -> void {
        m_first_bundle = std::move(bundle);
    }

    auto lease_key() const -> crypto::public_key {
        return m_lease_key.public_part();
    }

    auto release() const -> const wire::release_id& {
        return m_release;
    }

    // Before the session opens, to make it another session than a test's first.
    auto rename(const wire::session_id& session) -> void {
        m_session = session;
    }

private:
    auto lease_of(
        u64 sequence, const wire::module_nonce& nonce, const wire::release_id& named
    ) const -> wire::lease {
        return wire::sign_lease(
            wire::lease{
                .session = m_session,
                .device = id_of<wire::device_id>(2),
                .release = named,
                .sequence = sequence,
                .nonce = nonce,
                .duration = lease_duration,
                .data_revision = 0,
                .challenge = wire::hash_challenge{.nonce = {}, .offset = 0, .size = 16},
                .product = "cs2",
                .entitled = wire::entitled_features{.is_everything = false, .features = {7, 9}},
                .signature = {},
            },
            m_lease_key
        );
    }

    // The data route's frames count from 0, the first data's, apart from the lease route's.
    auto sealed_data(const crypto::secret_key& key, std::span<const std::byte> bundle)
        -> wire::frame {
        const std::vector<std::byte> plain = wire::encode_data_response(
            wire::data_response{
                .answers = 0,
                .data_revision = 0,
                .bundle_bytes = std::vector<std::byte>{bundle.begin(), bundle.end()},
                .unsupported = {},
            }
        );
        wire::frame frame = wire::seal_frame(
            key,
            wire::frame_contents{
                .header =
                    wire::frame_header{
                        .session = m_session,
                        .way = wire::direction::server_to_module,
                        .sequence = m_data_out,
                    },
                .nonce = {},
                .plain = plain,
            }
        );
        ++m_data_out;
        return frame;
    }

    auto sealed(const wire::lease& granted) -> wire::frame {
        const std::vector<std::byte> plain = wire::encode_lease(granted);
        wire::frame frame = wire::seal_frame(
            m_keys->lease.server_to_module,
            wire::frame_contents{
                .header =
                    wire::frame_header{
                        .session = m_session,
                        .way = wire::direction::server_to_module,
                        .sequence = m_out,
                    },
                .nonce = {},
                .plain = plain,
            }
        );
        ++m_out;
        return frame;
    }

    wire::session_id m_session = id_of<wire::session_id>(1);
    wire::release_id m_release = id_of<wire::release_id>(3);
    crypto::signing_key m_lease_key = crypto::signing_key::from_seed(seed_of(7));
    std::unique_ptr<wire::session_keys> m_keys;
    u64 m_out = 0;
    u64 m_data_out = 0;
    std::vector<std::byte> m_first_bundle{std::byte{1}, std::byte{2}, std::byte{3}};
};

auto identity_for(const stand_in_server& server) -> lease_identity {
    return lease_identity{
        .lease_key = server.lease_key(),
        .release = server.release(),
        .boot = wire::boot_report{
            .boot_info_version = 6,
            .kind = wire::image_kind::mapped,
            .image_base = 0x1'0000,
            .image_size = 0x2'0000,
        },
    };
}

auto client_for(const stand_in_server& server, seeded_random& random) -> lease_client {
    result<lease_client> client = lease_client::create(identity_for(server), random);
    REQUIRE(client.has_value());
    return std::move(*client);
}

constexpr error malformed{.code = error_code::malformed};

const stand_in_server::reply_options no_change{
    .release = std::nullopt,
    .nonce = std::nullopt,
    .is_signed_by_another_key = false,
    .is_data_under_lease_key = false,
};

// An opened client, its data route, and the server they talk to.
struct opened {
    stand_in_server server;
    seeded_random random{42};
    std::unique_ptr<lease_client> client;
    std::unique_ptr<data_client> data;
};

auto open_at_start(opened& session) -> void {
    session.client = std::make_unique<lease_client>(client_for(session.server, session.random));
    const std::vector<std::byte> reply =
        session.server.reply_to(session.client->hello(), no_change);
    result<session_opening> opening = session.client->open(reply, start);
    REQUIRE(opening.has_value());
    session.data = std::make_unique<data_client>(std::move(opening->data));
}

auto accept_data(data_client& data, std::span<const std::byte> frame)
    -> result<wire::data_response> {
    const result<wire::frame> sealed = wire::decode_frame(frame);
    REQUIRE(sealed.has_value());
    return data.accept(*sealed);
}

auto bundle_of(std::initializer_list<u8> values) -> std::vector<std::byte> {
    std::vector<std::byte> bytes;
    for (const u8 value : values) {
        bytes.push_back(std::byte{value});
    }
    return bytes;
}

// The server's answer to a data request for one module build, carrying this bundle.
auto ask_data(opened& session, std::vector<std::byte> bundle) -> stand_in_server::data_answer {
    const result<data_request_frame> asked =
        session.data->request({bundle::module_key{.name_hash = 5}}, session.random);
    REQUIRE(asked.has_value());
    return session.server.data_for(asked->frame, std::move(bundle));
}

auto renew(opened& session, clock::time_point when) -> std::vector<std::byte> {
    const result<std::vector<std::byte>> renewal = session.client->renewal(when, session.random);
    REQUIRE(renewal.has_value());
    return *renewal;
}

}

TEST_CASE("a reply signed by the lease key that answers this hello opens the session") {
    stand_in_server server;
    seeded_random random{1};
    lease_client client = client_for(server, random);

    const result<session_opening> opening =
        client.open(server.reply_to(client.hello(), no_change), start);

    REQUIRE(opening.has_value());
    CHECK(
        opening->entitled
        == entitlements{
            .is_everything = false,
            .features = {static_cast<feature_id>(7), static_cast<feature_id>(9)},
        }
    );
    CHECK(client.standing(start) == lease_standing::held);
}

TEST_CASE("a reply signed by any other key opens no session") {
    stand_in_server server;
    seeded_random random{1};
    lease_client client = client_for(server, random);

    const std::vector<std::byte> reply = server.reply_to(
        client.hello(),
        {
            .release = std::nullopt,
            .nonce = std::nullopt,
            .is_signed_by_another_key = true,
            .is_data_under_lease_key = false,
        }
    );

    CHECK(client.open(reply, start) == std::unexpected(malformed));
}

TEST_CASE("a first lease answering another hello's nonce opens no session") {
    stand_in_server server;
    seeded_random random{1};
    lease_client client = client_for(server, random);
    wire::module_nonce other{};
    other.fill(std::byte{0x5a});

    const std::vector<std::byte> reply = server.reply_to(
        client.hello(),
        {
            .release = std::nullopt,
            .nonce = other,
            .is_signed_by_another_key = false,
            .is_data_under_lease_key = false,
        }
    );

    CHECK(client.open(reply, start) == std::unexpected(malformed));
}

TEST_CASE("a first lease for another release opens no session") {
    stand_in_server server;
    seeded_random random{1};
    lease_client client = client_for(server, random);

    const stand_in_server::reply_options other_release{
        .release = id_of<wire::release_id>(4),
        .nonce = std::nullopt,
        .is_signed_by_another_key = false,
        .is_data_under_lease_key = false,
    };

    const std::vector<std::byte> reply = server.reply_to(client.hello(), other_release);

    CHECK(client.open(reply, start) == std::unexpected(malformed));
}

TEST_CASE("the session reply's first data opens on the data route and yields its bundle") {
    stand_in_server server;
    server.carry_first(bundle_of({0xb0, 0x0b}));
    seeded_random random{1};
    lease_client client = client_for(server, random);

    const result<session_opening> opening =
        client.open(server.reply_to(client.hello(), no_change), start);

    REQUIRE(opening.has_value());
    CHECK(opening->first_data.bundle_bytes == bundle_of({0xb0, 0x0b}));
}

TEST_CASE("a first data frame sealed under the lease route's key opens no session") {
    stand_in_server server;
    seeded_random random{1};
    lease_client client = client_for(server, random);

    const std::vector<std::byte> reply = server.reply_to(
        client.hello(),
        {
            .release = std::nullopt,
            .nonce = std::nullopt,
            .is_signed_by_another_key = false,
            .is_data_under_lease_key = true,
        }
    );

    CHECK(client.open(reply, start) == std::unexpected(malformed));
}

TEST_CASE("the data route counts its sequences apart from the lease route's") {
    opened session;
    open_at_start(session);
    // Two renewals and their leases take the lease route to sequence 2 both ways.
    REQUIRE(session.client->accept(session.server.lease_for(renew(session, start + 15s))));
    REQUIRE(session.client->accept(session.server.lease_for(renew(session, start + 30s))));

    const stand_in_server::data_answer answer = ask_data(session, bundle_of({0x5e}));

    CHECK(answer.request_header.sequence == 1);
    CHECK(answer.request.modules == std::vector{bundle::module_key{.name_hash = 5}});
    const result<wire::data_response> response = accept_data(*session.data, answer.response);
    CHECK(
        response
        == wire::data_response{
            .answers = 0,
            .data_revision = 0,
            .bundle_bytes = bundle_of({0x5e}),
            .unsupported = {},
        }
    );
}

TEST_CASE("the same data frame relayed twice is accepted once") {
    opened session;
    open_at_start(session);
    const std::vector<std::byte> response = ask_data(session, {}).response;

    REQUIRE(accept_data(*session.data, response).has_value());

    CHECK(accept_data(*session.data, response) == std::unexpected(malformed));
}

TEST_CASE("a lease frame never opens on the data route") {
    opened session;
    open_at_start(session);
    const std::vector<std::byte> lease = session.server.lease_for(renew(session, start + 15s));

    CHECK(accept_data(*session.data, lease) == std::unexpected(malformed));
}

TEST_CASE("a lease runs from when the request it answers was sent, not from when it arrived") {
    opened session;
    open_at_start(session);
    const std::vector<std::byte> renewal = renew(session, start + 15s);

    // The answer comes back half a minute late; the lease still counts from the send.
    REQUIRE(session.client->accept(session.server.lease_for(renewal)).has_value());

    CHECK(session.client->standing(start + 15s + lease_duration - 1s) == lease_standing::held);
    CHECK(session.client->standing(start + 15s + lease_duration) == lease_standing::lapsed);
}

TEST_CASE("a lease lapses at its end and the session ends after the resume window") {
    opened session;
    open_at_start(session);

    CHECK(session.client->standing(start + lease_duration - 1s) == lease_standing::held);
    CHECK(session.client->standing(start + lease_duration) == lease_standing::lapsed);
    CHECK(
        session.client->standing(start + lease_duration + resume_window - 1s)
        == lease_standing::lapsed
    );
    CHECK(
        session.client->standing(start + lease_duration + resume_window) == lease_standing::ended
    );
}

TEST_CASE("a lease that arrives inside the resume window holds the session again") {
    opened session;
    open_at_start(session);
    const clock::time_point late = start + lease_duration + 2 * 60s;
    REQUIRE(session.client->standing(late) == lease_standing::lapsed);

    REQUIRE(session.client->accept(session.server.lease_for(renew(session, late))).has_value());

    CHECK(session.client->standing(late) == lease_standing::held);
}

TEST_CASE("a renewal falls due once every interval after the last one") {
    opened session;
    open_at_start(session);

    CHECK_FALSE(session.client->is_renewal_due(start + renewal_interval - 1s));
    CHECK(session.client->is_renewal_due(start + renewal_interval));
    std::ignore = renew(session, start + renewal_interval);
    CHECK_FALSE(session.client->is_renewal_due(start + renewal_interval + 1s));
    CHECK(session.client->is_renewal_due(start + 2 * renewal_interval));
}

TEST_CASE("the same lease frame relayed twice is accepted once") {
    opened session;
    open_at_start(session);
    const std::vector<std::byte> lease = session.server.lease_for(renew(session, start + 15s));

    REQUIRE(session.client->accept(lease).has_value());

    CHECK(session.client->accept(lease) == std::unexpected(malformed));
}

TEST_CASE("a lease answering an earlier unanswered renewal for the same lease still counts") {
    opened session;
    open_at_start(session);
    const std::vector<std::byte> first = renew(session, start + 15s);
    std::ignore = renew(session, start + 30s);

    REQUIRE(session.client->accept(session.server.lease_for(first)).has_value());

    // Measured from the first renewal, the one it answers.
    CHECK(session.client->standing(start + 15s + lease_duration) == lease_standing::lapsed);
}

TEST_CASE("a lease frame for another session is refused and changes nothing") {
    opened session;
    open_at_start(session);
    opened other;
    other.server.rename(id_of<wire::session_id>(5));
    open_at_start(other);
    const std::vector<std::byte> foreign = other.server.lease_for(renew(other, start + 15s));
    std::ignore = renew(session, start + 15s);

    CHECK(session.client->accept(foreign) == std::unexpected(malformed));
    CHECK(session.client->standing(start + lease_duration) == lease_standing::lapsed);
}

TEST_CASE("the next change is the soonest of the renewal, the lapse and the end") {
    opened session;
    open_at_start(session);

    CHECK(session.client->next_change(start) == start + renewal_interval);
    // Past the renewal that was never sent, the lapse is still ahead.
    CHECK(session.client->next_change(start + 50s) == start + renewal_interval);
    std::ignore = renew(session, start + 50s);
    CHECK(session.client->next_change(start + 50s) == start + lease_duration);
    std::ignore = renew(session, start + lease_duration + 1s);
    CHECK(
        session.client->next_change(start + lease_duration + 1s)
        == start + lease_duration + 1s + renewal_interval
    );
}

}
