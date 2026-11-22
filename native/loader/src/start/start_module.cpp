#include "start/start_module.hpp"

#include <cstddef>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/match.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/launch/boot.hpp>
#include <lucent/launch/channel.hpp>
#include <lucent/launch/mapped_module.hpp>
#include <lucent/os/modules.hpp>
#include <lucent/os/process.hpp>
#include <lucent/wire/container.hpp>
#include <lucent/wire/container_stream.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/release_seal.hpp>
#include <lucent/wire/start.hpp>

#include "api/server.hpp"
#include "start/game.hpp"
#include "text/base64url.hpp"

namespace lucent::loader {
namespace {

// The largest image a container holds, sealed in 64 KiB chunks with a nonce and tag each.
constexpr usize max_stream_size =
    wire::max_container_image_size
    + (((wire::max_container_image_size / wire::container_chunk_size) + 1)
        * wire::sealed_chunk_overhead);

// Plaintext module bytes, wiped when this goes.
class plaintext final {
public:
    explicit plaintext(std::vector<std::byte> bytes)
        : m_bytes{std::move(bytes)} {}

    plaintext(const plaintext&) = delete ("the module in plaintext has one copy");
    auto operator=(const plaintext&) -> plaintext& = delete ("one copy");
    plaintext(plaintext&&) = delete ("wiped where it is");
    auto operator=(plaintext&&) -> plaintext& = delete ("wiped where it is");

    ~plaintext() {
        crypto::wipe(m_bytes);
    }

    auto bytes() const -> std::span<const std::byte> {
        return m_bytes;
    }

    // Hands the bytes on, leaving nothing here to wipe; the taker wipes them.
    auto take() -> std::vector<std::byte> {
        return std::exchange(m_bytes, {});
    }

private:
    std::vector<std::byte> m_bytes;
};

// An unpacked container, its sections wiped when this goes.
class unpacked_image final {
public:
    explicit unpacked_image(wire::container image)
        : m_image{std::move(image)} {}

    unpacked_image(const unpacked_image&) = delete ("the module in plaintext has one copy");
    auto operator=(const unpacked_image&) -> unpacked_image& = delete ("one copy");
    unpacked_image(unpacked_image&&) = delete ("wiped where it is");
    auto operator=(unpacked_image&&) -> unpacked_image& = delete ("wiped where it is");

    ~unpacked_image() {
        for (wire::container_section& section : m_image.sections) {
            crypto::wipe(section.data);
        }
    }

    auto image() const -> const wire::container& {
        return m_image;
    }

private:
    wire::container m_image;
};

auto malformed() -> std::unexpected<error> {
    return std::unexpected(error{.code = error_code::malformed});
}

auto container_digest_of(const wire::release_seal& seal) -> std::optional<crypto::digest> {
    for (const wire::release_artifact& artifact : seal.artifacts) {
        if (artifact.kind == wire::artifact_kind::container) {
            return artifact.digest;
        }
    }
    return std::nullopt;
}

// The seal the start answered with, as the code key signed it, for exactly what was asked.
auto checked_seal(const wire::start_reply& reply, const start_request_inputs& inputs)
    -> result<wire::release_seal> {
    wire::release_seal seal =
        LUCENT_TRY(wire::verify_release_seal(reply.release_seal, inputs.code_key));
    if (seal.product != inputs.product.id
        || seal.chosen != inputs.chosen
        || !container_digest_of(seal)) {
        return malformed();
    }
    if (seal.boot_info_version != kit::boot_info_version) {
        return std::unexpected(error{.code = error_code::version_mismatch});
    }
    return seal;
}

// The packed container, opened chunk by chunk as it arrives and checked against the seal.
auto fetch_container(
    server& api,
    std::string_view access_token,
    const wire::start_reply& reply,
    const wire::release_seal& seal
) -> result<std::variant<std::vector<std::byte>, wire::refusal>> {
    const std::string path = std::format("/v1/starts/{}/container", to_hex(reply.start.bytes));
    wire::container_stream_opener opener{reply.container_key};
    const auto feed = [&opener](std::span<const std::byte> piece) { return opener.feed(piece); };
    const std::optional<wire::refusal> refused = LUCENT_TRY(api.stream(
        call{
            .method = "GET",
            .path = path,
            .access_token = access_token,
            .body = {},
            .kind = operation::none,
            .max_body = max_stream_size,
        },
        feed
    ));
    if (refused) {
        return *refused;
    }
    plaintext packed{LUCENT_TRY(opener.finish())};
    if (crypto::hash(packed.bytes()) != container_digest_of(seal)) {
        return malformed();
    }
    return packed.take();
}

// Maps the container into the game and runs its boot entry with a session channel of its own.
auto map_and_boot(const os::process& game, const wire::container& image)
    -> result<launch::host_channel> {
    if (image.boot_rva == 0 || image.boot_info_version != kit::boot_info_version) {
        return malformed();
    }
    const launch::mapped_module mapped = LUCENT_TRY(launch::map_container_module(game, image));
    launch::host_channel channel = LUCENT_TRY(launch::open_channel(game));
    channel.boot.kind = kit::image_kind::mapped;
    channel.boot.trampolines = mapped.trampolines;
    channel.boot.entry_rva = mapped.entry_rva;
    channel.boot.pdata_rva = mapped.pdata_rva;
    channel.boot.pdata_size = mapped.pdata_size;
    // No bundle in boot_info: release bundles come over the session once the server assembles
    // them (wishlist, Phase 1), and a module with none applies no facts.
    LUCENT_TRY(
        launch::start_module(
            game,
            launch::boot_request{
                .entry = mapped.base + image.boot_rva, .info = channel.boot, .bundle = {}
            }
        )
    );
    return channel;
}

}

auto start_module(
    server& api,
    std::string_view access_token,
    const os::process& game,
    const start_request_inputs& inputs
) -> result<start_outcome> {
    const std::vector<os::remote_module> loaded = LUCENT_TRY(os::remote_modules(game));
    const std::vector<os::remote_module> modules = game_modules(inputs.product, loaded);
    const std::vector<bundle::module_key> builds = LUCENT_TRY(module_builds(game, modules));
    const std::vector<std::byte> body = wire::encode_start_request(
        wire::start_request{
            .product = std::string{inputs.product.id},
            .chosen = inputs.chosen,
            .loader_release = inputs.loader_release,
            .modules = builds,
        }
    );
    const answer started = LUCENT_TRY(api.send(
        call{
            .method = "POST",
            .path = "/v1/starts",
            .access_token = access_token,
            .body = body,
            .kind = operation::fresh,
        }
    ));
    if (const std::optional<wire::refusal> refused = refusal_in(started)) {
        return *refused;
    }
    const wire::start_reply reply = LUCENT_TRY(wire::decode_start_reply(body_in(started)));
    const wire::release_seal seal = LUCENT_TRY(checked_seal(reply, inputs));
    if (seal.number < inputs.highest_seen) {
        return stale_release{.served = seal.number, .highest = inputs.highest_seen};
    }
    answer fetched = LUCENT_TRY(fetch_container(api, access_token, reply, seal));
    if (const std::optional<wire::refusal> refused = refusal_in(fetched)) {
        return *refused;
    }
    // The module exists in plaintext here only until it's in the game: the packed bytes go once
    // unpacked, the sections once mapped, on every path.
    result<wire::container> unpacked = [&fetched] {
        const plaintext packed{match(
            fetched,
            [](std::vector<std::byte>& bytes) { return std::move(bytes); },
            [](const wire::refusal&) { return std::vector<std::byte>{}; }
        )};
        return wire::unpack_container(packed.bytes());
    }();
    if (!unpacked) {
        return std::unexpected(unpacked.error());
    }
    const unpacked_image image{*std::move(unpacked)};
    if (image.image().release != seal.release) {
        return malformed();
    }
    return started_module{
        .start = reply.start,
        .channel = LUCENT_TRY(map_and_boot(game, image.image())),
        .seal_number = seal.number,
    };
}

}
