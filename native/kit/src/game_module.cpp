#include <lucent/kit/game_module.hpp>

#include <bit>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/text.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/pe/image_view.hpp>

#include "time_date_stamp.hpp"

namespace lucent::kit {

auto module_build_of(const pe::image_view& image, std::string_view name)
    -> result<bundle::module_key> {
    return bundle::module_key{
        .name_hash = module_name_hash(name),
        .time_date_stamp = LUCENT_TRY(detail::time_date_stamp_of(image)),
        .size_of_image = image.size_of_image(),
    };
}

auto loaded_game_modules(std::span<const game_module> known) -> std::vector<loaded_module> {
    std::vector<loaded_module> loaded;
    for (const game_module& module : known) {
        const std::wstring name = to_wide(module.name);
        const HMODULE handle = GetModuleHandleW(name.c_str());
        if (handle == nullptr) {
            continue;
        }
        result<module_image> image = image_at(module.index, std::bit_cast<uptr>(handle));
        if (!image) {
            continue;
        }
        loaded.push_back(
            loaded_module{
                .build =
                    bundle::module_key{
                        .name_hash = module_name_hash(module.name),
                        .time_date_stamp = image->time_date_stamp,
                        .size_of_image = image->size_of_image,
                    },
                .image = *std::move(image),
            }
        );
    }
    return loaded;
}

}
