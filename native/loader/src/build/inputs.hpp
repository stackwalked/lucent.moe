#pragma once

#include <optional>
#include <string_view>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

// What the build configured into this loader. Each is defined in inputs.cpp alone, so a new value
// rebuilds one file.

namespace lucent::loader {

// The offline code key's public half: the loader acts on a seal only when it verifies under it.
// Nothing when the build named none (a dev build), and then every seal is refused.
auto code_key() -> std::optional<crypto::public_key>;

// The release this loader was built as, which a start must name. Nothing in a dev build: it never
// updates itself, and starts only against a dev server whose loader seal names the all-zero id.
auto own_release() -> std::optional<wire::release_id>;

// Where the loader talks to: the native listener and the browser origin sign-in opens.
struct origins {
    std::string_view api;
    std::string_view web;
};

auto server_origins() -> origins;

}
