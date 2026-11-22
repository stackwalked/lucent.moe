#pragma once

#include <string_view>
#include <variant>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/refusal.hpp>

#include "api/server.hpp"
#include "cng/device_key.hpp"

// Enrolling the PC (POST /v1/enrollments, then polls of GET /v1/enrollments/:id): the device key
// asks, the member approves in the browser against the match code both sides derive from the
// key's thumbprint.

namespace lucent::loader {

struct enrolled {};

// The member denied it, or let it expire.
struct not_approved {
    wire::enrollment_state state = wire::enrollment_state::denied;
};

using enrollment_outcome = std::variant<enrolled, not_approved, wire::refusal>;

// Shows the member the match code to compare on the approval page.
using show_match_code = stdx::function_ref<void(std::string_view code)>;

// Asks, then polls until the member decides. The access token is fetched before each call, since
// approval can outlast one.
using token_source = stdx::function_ref<result<std::string>()>;

auto enroll(server& api, const device_key& key, token_source token, show_match_code show)
    -> result<enrollment_outcome>;

}
