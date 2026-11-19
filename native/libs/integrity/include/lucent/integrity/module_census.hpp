#pragma once

#include <array>
#include <span>

#include <lucent/crypto/crypto.hpp>

namespace lucent::integrity {

inline constexpr usize hashed_unsigned_limit = 4;

// The modules a process's loader knows about, counted by who signed their files. Signatures are
// checked offline: embedded first, then the system catalogs.
struct module_census {
    u16 by_microsoft = 0;
    u16 by_other_signer = 0;
    // No valid signature: none at all, or one that no longer matches the file.
    u16 without_signature = 0;
    // The file could not be named, opened or read: deleted since it loaded, say.
    u16 unreadable = 0;
    // BLAKE2b-256 of the first unsigned files in load order, leaving out known ones.
    std::array<crypto::digest, hashed_unsigned_limit> unsigned_files{};
    u8 unsigned_file_count = 0;

    auto operator==(const module_census&) const -> bool = default;
};

// `process` is a kernel handle with PROCESS_QUERY_INFORMATION and PROCESS_VM_READ, naming one of
// our own processes; GetCurrentProcess() names this one. `known` are file hashes of our own
// unsigned files, which are counted but take no hash slot.
auto module_census_of(void* process, std::span<const crypto::digest> known)
    -> result<module_census>;

}
