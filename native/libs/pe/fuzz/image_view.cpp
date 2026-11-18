#include <lucent/pe/image_view.hpp>

#include <array>
#include <bit>
#include <cstddef>
#include <optional>
#include <span>
#include <tuple>

#include <lucent/fuzzing/run_one.hpp>

// image_view::parse over arbitrary bytes in both layouts, then every query a parsed view answers.
// Every span it hands out must lie inside the input. Seed with small x64 images, for example a few
// DLLs from System32 under 64 KiB; the inputs it finds stay out of git.

namespace lucent::fuzzing {
namespace {

constexpr std::array layouts{pe::layout::file, pe::layout::mapped};
constexpr std::array directory_kinds{
    pe::directory_kind::exports,
    pe::directory_kind::imports,
    pe::directory_kind::exceptions,
    pe::directory_kind::base_relocations,
    pe::directory_kind::tls,
    pe::directory_kind::load_config,
};

auto is_inside(std::span<const std::byte> part, std::span<const std::byte> whole) -> bool {
    const uptr start = std::bit_cast<uptr>(part.data());
    const uptr whole_start = std::bit_cast<uptr>(whole.data());
    return part.empty()
           || (start >= whole_start && start + part.size() <= whole_start + whole.size());
}

auto check_span(result<std::span<const std::byte>> part, std::span<const std::byte> input) -> void {
    LUCENT_INVARIANT(!part || is_inside(*part, input));
}

auto query(const pe::image_view& image, std::span<const std::byte> input) -> void {
    LUCENT_INVARIANT(is_inside(image.headers(), input));
    for (const pe::section& stored : image.sections()) {
        std::ignore = pe::mapped_size_of(stored);
        check_span(image.contents_of(stored), input);
    }
    for (const pe::directory_kind kind : directory_kinds) {
        const std::optional<pe::directory> found = image.find_directory(kind);
        if (found) {
            check_span(image.bytes_at({.rva = found->rva, .size = found->size}), input);
            std::ignore = image.string_at(found->rva);
        }
    }
    std::ignore = image.string_at(image.entry_point());
    std::ignore = pe::to_mapped_layout(image);
}

}

auto run_one(std::span<const std::byte> input) -> void {
    for (const pe::layout arrangement : layouts) {
        const result<pe::image_view> image = pe::image_view::parse(input, arrangement);
        if (image) {
            query(*image, input);
        }
    }
}

}
