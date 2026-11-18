#include <lucent/pe/exports.hpp>

#include <array>
#include <cstddef>
#include <ranges>
#include <span>
#include <tuple>

#include <lucent/fuzzing/run_one.hpp>
#include <lucent/pe/image_view.hpp>

// export_table::from_image over whatever image_view::parse accepts, in both layouts, then lookups
// into what it read. Seed with small x64 images that export something, as for image_view.

namespace lucent::fuzzing {
namespace {

// Real tables start their ordinals at 0 or 1; a mutated base moves them, and the lookup is the
// same code for any ordinal, so a short range reaches every branch of find.
constexpr u16 looked_up_ordinals = 1024;

auto look_up(const pe::export_table& table) -> void {
    for (const u16 ordinal : std::views::iota(u16{0}, looked_up_ordinals)) {
        std::ignore = table.find(pe::export_ordinal{ordinal});
    }
    std::ignore = table.find("");
    std::ignore = table.ordinal_of("");
}

}

auto run_one(std::span<const std::byte> input) -> void {
    for (const pe::layout arrangement : std::array{pe::layout::file, pe::layout::mapped}) {
        const result<pe::image_view> image = pe::image_view::parse(input, arrangement);
        if (!image) {
            continue;
        }
        const result<pe::export_table> table = pe::export_table::from_image(*image);
        if (table) {
            look_up(*table);
        }
    }
}

}
