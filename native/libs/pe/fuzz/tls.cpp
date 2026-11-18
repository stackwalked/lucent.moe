#include <lucent/pe/tls.hpp>

#include <array>
#include <cstddef>
#include <span>
#include <tuple>

#include <lucent/fuzzing/run_one.hpp>
#include <lucent/pe/image_view.hpp>

// tls_of over whatever image_view::parse accepts, in both layouts. Seed with small x64 images that
// have one, as for image_view.

namespace lucent::fuzzing {

auto run_one(std::span<const std::byte> input) -> void {
    for (const pe::layout arrangement : std::array{pe::layout::file, pe::layout::mapped}) {
        const result<pe::image_view> image = pe::image_view::parse(input, arrangement);
        if (image) {
            std::ignore = pe::tls_of(*image);
        }
    }
}

}
