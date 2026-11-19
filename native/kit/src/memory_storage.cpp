#include <lucent/kit/memory_storage.hpp>

#include <vector>

#include <lucent/kit/profile.hpp>

namespace lucent::kit {

auto memory_storage::profiles() const -> std::vector<profile> {
    return {m_profiles.values().begin(), m_profiles.values().end()};
}

auto memory_storage::keep(const profile& kept) -> void {
    m_profiles.insert_or_assign(kept.id, kept);
}

auto memory_storage::forget(profile_id removed) -> void {
    m_profiles.erase(removed);
}

}
