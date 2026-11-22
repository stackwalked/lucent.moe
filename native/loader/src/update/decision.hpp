#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <variant>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/release_seal.hpp>

// Whether the loader is the one the server serves now (protection.md, Delivery): a seal acts only
// when the code key signed it, names the loader, and is numbered at least as high as any loader
// seal seen before. Going back is the old code signed again under a new
// number, never an old seal served again.

namespace lucent::loader {

inline constexpr std::string_view loader_product = "lucent-loader";

// The loader is one release line, not a product with channels: its seals are all signed for
// stable, and the channel a member picks is the product's.
inline constexpr wire::channel loader_channel = wire::channel::stable;

struct up_to_date {
    wire::release_seal seal;
};

struct update_needed {
    wire::release_seal seal;
};

// The served seal is numbered below one this PC has already seen.
struct rollback_refused {
    u64 served = 0;
    u64 highest = 0;
};

using update_decision = std::variant<up_to_date, update_needed, rollback_refused>;

struct update_inputs {
    std::span<const std::byte> seal;
    crypto::public_key code_key{};
    // This build's release; nothing in a dev build, which is never the one served.
    std::optional<wire::release_id> own;
    u64 highest_seen = 0;
};

// Fails as malformed when the seal doesn't verify or isn't the loader's.
auto decide_update(const update_inputs& inputs) -> result<update_decision>;

}
