#pragma once

#include <array>

#include <lucent/kit/context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::cs2::features {

enum class sample_shape : u8 { square, circle, diamond };

struct dev_sample_settings {
    bool is_outlined = true;
    f32 size = 4.0F;
    sample_shape shape = sample_shape::square;
    kit::color tint{.r = 255, .g = 0, .b = 153, .a = 255};

    static constexpr auto describe() -> std::array<kit::setting<dev_sample_settings>, 4> {
        return {
            kit::toggle<"sample/outline", &dev_sample_settings::is_outlined>(),
            kit::number<"sample/size", &dev_sample_settings::size>(
                {.min = 1.0F, .max = 10.0F, .step = 0.5F}
            ),
            kit::choice<
                "sample/shape",
                &dev_sample_settings::shape,
                "square",
                "circle",
                "diamond">(),
            kit::color_of<"sample/tint", &dev_sample_settings::tint>(),
        };
    }
};

// One setting of each kind and nothing to do: dev builds wire it so the menu has a page to show
// until the first real feature lands with the world domain. Never wired in a release.
class dev_sample final {
public:
    static constexpr kit::feature_id id = kit::feature_id_of<"dev_sample">;
    using needs = kit::needs<>;
    using wants = kit::wants<>;
    using settings = dev_sample_settings;

    auto tick(const kit::context<dev_sample>& /*parts*/) -> void {}
};

}
