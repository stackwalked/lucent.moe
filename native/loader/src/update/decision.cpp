#include "update/decision.hpp"

#include <expected>
#include <utility>

#include <lucent/wire/release_seal.hpp>

namespace lucent::loader {

auto decide_update(const update_inputs& inputs) -> result<update_decision> {
    wire::release_seal seal = LUCENT_TRY(wire::verify_release_seal(inputs.seal, inputs.code_key));
    // The seal's artifact set already says loader or module; the product says whose.
    if (seal.product != loader_product
        || seal.chosen != loader_channel
        || seal.artifacts.front().kind != wire::artifact_kind::loader) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (seal.number < inputs.highest_seen) {
        return rollback_refused{.served = seal.number, .highest = inputs.highest_seen};
    }
    if (inputs.own == seal.release) {
        return up_to_date{.seal = std::move(seal)};
    }
    return update_needed{.seal = std::move(seal)};
}

}
