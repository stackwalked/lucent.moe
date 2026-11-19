#pragma once

#include <lucent/kit/capability.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/view_set.hpp>

namespace lucent::kit {

// What a feature's tick sees: the parts it declared and its settings as of this tick's safe
// point. A part it didn't declare fails to compile, so a feature's requirements are its
// declarations. Borrowed for one tick.
//
// Only a class constrains F here: a feature names its context in its own tick's declaration,
// while it is still incomplete. What it declares is checked where it is wired, and by each part
// it asks for.
template <class_type F>
class context final {
public:
    using settings_type = F::settings;

    // The registry builds one only once every needed part is in parts; a test does the same.
    context(const view_set& parts, const settings_type& current)
        : m_parts{&parts}
        , m_settings{&current} {}

    template <needed_by<F> Part>
    auto view() const -> const Part& {
        const Part* const found = m_parts->find<Part>();
        LUCENT_INVARIANT(found != nullptr);
        return *found;
    }

    // Null when the domain couldn't build it this tick.
    template <wanted_by<F> Part>
    auto maybe() const -> const Part* {
        return m_parts->find<Part>();
    }

    auto settings() const -> const settings_type& {
        return *m_settings;
    }

private:
    const view_set* m_parts;
    const settings_type* m_settings;
};

// Whether every part F needs is in parts, so its context can be built.
template <feature_like F>
auto has_needs(const view_set& parts) -> bool {
    return []<typename... Parts>(const view_set& given, needs<Parts...> /*declared*/) {
        return ((given.find<Parts>() != nullptr) && ...);
    }(parts, typename F::needs{});
}

// Whether every capability behind a part F needs is available: if not, F is unavailable.
template <feature_like F>
auto are_needs_available() -> bool {
    return []<typename... Parts>(needs<Parts...> /*declared*/) {
        return (is_available(typename Parts::backing{}) && ...);
    }(typename F::needs{});
}

}
