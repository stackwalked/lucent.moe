#pragma once

#include <string>

namespace lucent::integrity::detail {

enum class signer : u8 { microsoft, other, none };

// Who signed the open file at `path`, through its embedded signature or else a system catalog.
// Offline: no revocation checks and no URL retrieval beyond the local cache.
auto signer_of(void* file, const std::wstring& path) -> signer;

}
