#pragma once

#include <span>

#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::menu {

// A wired feature's settings as describe() lists them, in the order its snapshot's values come in.
// The registry's snapshot carries values only, so the target hands the menu these beside it.
struct described_feature {
    kit::feature_id id{};
    std::span<const kit::setting_description> settings;
};

template <kit::feature_like F>
inline constexpr described_feature description_of{
    .id = F::id,
    .settings = kit::descriptions_of<typename F::settings>,
};

}
