#include <lucent/core/build/subkeys.hpp>

namespace lucent {

static_assert(build::fact_subkey != build::event_subkey, "each purpose has its own subkey");
static_assert(build::fact_subkey != build::api_subkey, "fact and API subkeys differ");
static_assert(build::fact_subkey != build::link_order_subkey, "fact and link order subkeys differ");
static_assert(build::event_subkey != build::api_subkey, "event and API subkeys differ");
static_assert(build::event_subkey != build::link_order_subkey, "event and link subkeys differ");
static_assert(build::api_subkey != build::link_order_subkey, "API and link order subkeys differ");
static_assert(build::fact_subkey != build::subkey{}, "a subkey is derived, not left zero");

}
