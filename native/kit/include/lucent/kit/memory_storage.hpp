#pragma once

#include <flat_map>
#include <vector>

#include <lucent/kit/profile.hpp>
#include <lucent/kit/profile_storage.hpp>

namespace lucent::kit {

// Keeps profiles for the session only: nothing reaches a disk.
class memory_storage final : public profile_storage {
public:
    memory_storage() = default;

    auto profiles() const -> std::vector<profile> override;
    auto keep(const profile& kept) -> void override;
    auto forget(profile_id removed) -> void override;

private:
    std::flat_map<profile_id, profile> m_profiles;
};

}
