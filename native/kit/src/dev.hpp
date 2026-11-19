#pragma once

#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/session.hpp>

// What kit's shared sources do in dev builds only. Defined in the dev-only sources
// (dev_channel.cpp, dev_facts.cpp) and called only from discarded-in-release `if constexpr
// (is_dev_build)` branches, so a release build neither compiles nor links any of it.

namespace lucent::kit::detail {

// Lifecycle thread only. The dev channel sends over this session until withdrawn; withdrawing
// waits for sends already under way, so the session may be destroyed once it returns.
auto publish_dev_session(session& channel) -> void;
auto withdraw_dev_session() -> void;

// The resolve stage's outcome, as dev text.
auto report_facts(const result<apply_report>& applied) -> void;
auto report_no_bundle() -> void;

}
