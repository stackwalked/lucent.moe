#include "data_client.hpp"

#include <algorithm>
#include <cstddef>
#include <expected>
#include <optional>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/session.hpp>

#include "random.hpp"

namespace lucent::kit::detail {

data_client::data_client(wire::session_id session, wire::route_keys keys)
    : m_session{session}
    , m_keys{std::move(keys)} {}

auto data_client::request(std::vector<bundle::module_key> modules, random_source& random)
    -> result<data_request_frame> {
    std::ranges::sort(modules);
    const auto repeated = std::ranges::unique(modules);
    modules.erase(repeated.begin(), repeated.end());
    crypto::aead_nonce nonce{};
    LUCENT_TRY(random.fill(nonce));
    // Phase 1 asks per module build only; features stay none, for every entry entitled.
    const std::vector<std::byte> plain = wire::encode_data_request(
        wire::data_request{.modules = std::move(modules), .features = std::nullopt}
    );
    const u64 sequence = m_last_out + 1;
    const wire::frame sealed = wire::seal_frame(
        m_keys.module_to_server,
        wire::frame_contents{
            .header =
                wire::frame_header{
                    .session = m_session,
                    .way = wire::direction::module_to_server,
                    .sequence = sequence,
                },
            .nonce = nonce,
            .plain = plain,
        }
    );
    m_last_out = sequence;
    return data_request_frame{.frame = wire::encode_frame(sealed), .sequence = sequence};
}

auto data_client::accept(const wire::frame& sealed) -> result<wire::data_response> {
    // A replayed or reordered frame is refused before it is opened, as frame.hpp says.
    if (sealed.header.way != wire::direction::server_to_module
        || sealed.header.session != m_session
        || (m_highest_in && sealed.header.sequence <= *m_highest_in)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    const crypto::secret_bytes plain =
        LUCENT_TRY(wire::open_frame(m_keys.server_to_module, sealed));
    wire::data_response response = LUCENT_TRY(wire::decode_data_response(plain.as_bytes()));
    m_highest_in = sealed.header.sequence;
    return response;
}

}
