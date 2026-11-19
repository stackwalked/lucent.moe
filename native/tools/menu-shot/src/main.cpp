#include <charconv>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <optional>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/cs2-features/all.hpp>
#include <lucent/cs2-overlay/dev_catalog.hpp>
#include <lucent/d3d11/offscreen.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/menu/settings_menu.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/system_font.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::menu_shot {
namespace {

constexpr std::string_view usage = "menu-shot settings <output.png> [dark|light] [scale: 0.5..3]";

struct options {
    std::filesystem::path output;
    ui::theme_preset theme = ui::theme_preset::dark;
    f32 scale = 1.0F;
};

// NaN fails both comparisons, so it is refused too.
auto is_supported_scale(f32 scale) -> bool {
    return scale >= 0.5F && scale <= 3.0F;
}

auto argument(std::span<const wchar_t* const> args, isize index) -> std::wstring_view {
    return std::wstring_view{args.subspan(narrow<usize>(index)).front()};
}

auto parse(std::span<const wchar_t* const> args) -> std::optional<options> {
    if (args.size() < 2 || args.size() > 4 || argument(args, 0) != L"settings") {
        return std::nullopt;
    }
    options chosen{.output = argument(args, 1)};
    if (args.size() >= 3) {
        const std::wstring_view theme = argument(args, 2);
        if (theme == L"light") {
            chosen.theme = ui::theme_preset::light;
        } else if (theme != L"dark") {
            return std::nullopt;
        }
    }
    if (args.size() == 4) {
        const std::string scale = to_utf8(argument(args, 3));
        const char* end = std::to_address(scale.end());
        const std::from_chars_result parsed = std::from_chars(scale.data(), end, chosen.scale);
        if (parsed.ec != std::errc{} || parsed.ptr != end || !is_supported_scale(chosen.scale)) {
            return std::nullopt;
        }
    }
    return chosen;
}

auto record(const options& chosen, draw::draw_list& list, text::text_system& text) -> result<void> {
    const text::face_id face = LUCENT_TRY(text::add_message_font(text));
    menu::table_catalog labels;
    cs2::overlay::add_dev_text(labels);
    kit::wiring wired;
    cs2::features::wire(wired);
    const kit::test_clock time;
    kit::registry features{std::move(wired), {.is_everything = true, .features = {}}, time};
    menu::settings_menu settings{
        text, {.tokens = menu::menu_theme(face, chosen.theme), .text = &labels}, features
    };
    const draw::pixel_size size = list.frame().target;
    const draw::vec2 viewport{
        .x = static_cast<f32>(size.width) / chosen.scale,
        .y = static_cast<f32>(size.height) / chosen.scale,
    };
    text.begin_frame();
    LUCENT_TRY(
        settings.draw({.input = {}, .viewport = viewport, .pixels_per_unit = chosen.scale}, list)
    );
    return {};
}

auto capture(const options& chosen) -> result<void> {
    const draw::pixel_size size{
        .width = static_cast<i32>(std::ceil(512.0F * chosen.scale)),
        .height = static_cast<i32>(std::ceil(768.0F * chosen.scale)),
    };
    const d3d11::testing::warp_device device = LUCENT_TRY(d3d11::testing::warp_device::create());
    d3d11::testing::test_target target = LUCENT_TRY(
        d3d11::testing::test_target::create(
            device,
            {.size = size,
                .format = DXGI_FORMAT_R8G8B8A8_UNORM,
                .view_format = DXGI_FORMAT_R8G8B8A8_UNORM}
        )
    );
    d3d11::renderer renderer =
        LUCENT_TRY(d3d11::renderer::from_device(device.device(), device.context()));
    LUCENT_TRY(renderer.build());
    target.clear({.r = 62, .g = 68, .b = 78, .a = 255});
    draw::draw_list list;
    list.reset({.size = size, .pixels_per_unit = chosen.scale});
    // One frame is the whole run, so every glyph is rasterized in it.
    text::text_system text = LUCENT_TRY(
        text::text_system::create({.raster_budget = 4096, .layout_lifetime = 1, .atlas = {}})
    );
    LUCENT_TRY(record(chosen, list, text));
    for (const text::atlas_patch& patch : text.take_patches()) {
        const d3d11::atlas_upload upload{
            .page = patch.page,
            .area = patch.area,
            .coverage = patch.coverage,
            .row_pitch = patch.row_pitch,
        };
        renderer.upload_atlas(std::span{&upload, 1});
    }
    LUCENT_TRY(renderer.render(list.frame(), target.as_render_target()));
    const d3d11::testing::image pixels = LUCENT_TRY(d3d11::testing::read_back(device, target));
    // A directory that can't be made fails the write that follows, which reports it.
    std::error_code ignored;
    std::filesystem::create_directories(chosen.output.parent_path(), ignored);
    return d3d11::testing::write_png(chosen.output, pixels);
}

}
}

// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT's entry signature.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> args{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    if (args.size() == 2 && std::wstring_view{args.back()} == L"--help") {
        std::println("{}", lucent::menu_shot::usage);
        return 0;
    }
    const auto chosen = lucent::menu_shot::parse(args.subspan(1));
    if (!chosen) {
        std::println(stderr, "{}", lucent::menu_shot::usage);
        return 2;
    }
    const lucent::result<void> shot = lucent::menu_shot::capture(*chosen);
    if (!shot) {
        std::println(
            stderr,
            "menu-shot: {}: error {} (system {:#x})",
            lucent::to_utf8(chosen->output.native()),
            std::to_underlying(shot.error().code),
            shot.error().system_code
        );
        return 1;
    }
    return 0;
}
