#pragma once

#include <vector>

#include <lucent/kit/profile.hpp>

namespace lucent::kit {

// Where profiles are kept beyond the config store's working copy: memory until phase 4, then the
// cloud-held configs. The store calls it on its own thread after every change it makes.
class profile_storage {
public:
    profile_storage(const profile_storage&) = delete ("the config store borrows it");
    auto operator=(const profile_storage&)
        -> profile_storage& = delete ("the config store borrows it");
    profile_storage(profile_storage&&) = delete ("the config store borrows it");
    auto operator=(profile_storage&&) -> profile_storage& = delete ("the config store borrows it");
    virtual ~profile_storage() = default;

    // Every profile it keeps, as the store starts: possibly made by an older build, so the store
    // completes each against what is wired now.
    virtual auto profiles() const -> std::vector<profile> = 0;
    // Created or changed.
    virtual auto keep(const profile& kept) -> void = 0;
    virtual auto forget(profile_id removed) -> void = 0;

protected:
    profile_storage() = default;
};

}
