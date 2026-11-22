#include "start/game.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cwctype>
#include <expected>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <corecrt.h>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/modules.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/wire/start.hpp>

namespace lucent::loader {
namespace {

// The headers are read from the module's first page. Headers longer than that fail to parse and
// fail the start, rather than reporting a build the headers don't say.
// build: cs2 1.41.9.9's modules (unverified beyond the linkers' usual 0x400 SizeOfHeaders)
// found: PE's SizeOfHeaders is the DOS stub, NT headers and section table rounded to FileAlignment
// breaks: a module with over 0x1000 bytes of headers refuses every start
constexpr usize header_read_size = 0x1000;

// Under the root, compared case-insensitively as Windows compares paths.
struct containment {
    std::filesystem::path path;
    std::filesystem::path root;
};

auto is_under(const containment& question) -> bool {
    const std::wstring lowered_path =
        std::filesystem::path{question.path}.make_preferred().wstring();
    const std::wstring lowered_root =
        std::filesystem::path{question.root}.make_preferred().wstring();
    if (lowered_path.size() <= lowered_root.size()) {
        return false;
    }
    const auto same = [](wchar_t left, wchar_t right) {
        return std::towlower(static_cast<wint_t>(left))
               == std::towlower(static_cast<wint_t>(right));
    };
    return std::ranges::equal(
               std::wstring_view{lowered_path}.substr(0, lowered_root.size()), lowered_root, same
           )
           && lowered_path.at(lowered_root.size()) == L'\\';
}

}

auto find_game_product(std::string_view id) -> std::optional<game_product> {
    if (id == cs2.id) {
        return cs2;
    }
    return std::nullopt;
}

auto open_game(const game_product& product) -> result<os::process> {
    const u32 id = LUCENT_TRY(os::find_process_id(product.executable));
    return os::process::open(id);
}

auto is_ready(const game_product& product, const os::process& game) -> bool {
    return os::find_remote_module(game, product.ready_module).has_value();
}

auto game_modules(const game_product& product, std::span<const os::remote_module> loaded)
    -> std::vector<os::remote_module> {
    const auto executable = std::ranges::find_if(loaded, [&product](const os::remote_module& each) {
        return std::ranges::equal(each.name, product.executable, [](char left, char right) {
            return std::tolower(static_cast<u8>(left)) == std::tolower(static_cast<u8>(right));
        });
    });
    if (executable == loaded.end()) {
        return {};
    }
    std::filesystem::path root = executable->path.parent_path();
    for (u32 level = 0; level < product.root_levels; ++level) {
        root = root.parent_path();
    }
    std::vector<os::remote_module> found;
    for (const os::remote_module& each : loaded) {
        if (is_under({.path = each.path, .root = root})) {
            found.push_back(each);
        }
    }
    return found;
}

auto module_builds(const os::process& game, std::span<const os::remote_module> modules)
    -> result<std::vector<bundle::module_key>> {
    std::vector<bundle::module_key> builds;
    for (const os::remote_module& each : modules) {
        const std::vector<std::byte> headers = LUCENT_TRY(
            os::read_remote(
                game,
                os::remote_range{
                    .address = each.base, .size = std::min(header_read_size, each.size)
                }
            )
        );
        const pe::image_view image = LUCENT_TRY(pe::image_view::parse(headers, pe::layout::mapped));
        builds.push_back(LUCENT_TRY(kit::module_build_of(image, each.name)));
    }
    std::ranges::sort(builds);
    const auto duplicates = std::ranges::unique(builds);
    builds.erase(duplicates.begin(), duplicates.end());
    if (builds.size() > wire::max_start_modules) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    return builds;
}

}
