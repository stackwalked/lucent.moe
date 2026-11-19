#include <array>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <optional>
#include <print>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#include <lucent/core/narrow.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/core/text.hpp>
#include <lucent/cs2-features/all.hpp>
#include <lucent/cs2-overlay/dev_catalog.hpp>
#include <lucent/d3d11/offscreen.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/config_store.hpp>
#include <lucent/kit/memory_storage.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/menu/settings_menu.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/text/system_font.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/hud_window.hpp>
#include <lucent/ui/label.hpp>
#include <lucent/ui/theme.hpp>

#include "lucent/ui/element_id.hpp"

namespace lucent::menu_shot {
namespace {

constexpr std::string_view usage =
    "menu-shot settings <output.png> [dark|light|contrast] [scale: 0.5..3]\n"
    "menu-shot hud <output.png> [dark|light|contrast] [scale: 0.5..3] [locked|arranging]";

// The glass samples its backdrop's light a frame or more after drawing it; the shot is drawn this
// many times, each frame given the light the last one sampled, so it shows the theme the game
// would settle on.
constexpr isize settling_frames = 4;

enum class subject : u8 {
    settings,
    hud,
};

struct options {
    subject shown = subject::settings;
    std::filesystem::path output;
    ui::theme_preset theme = ui::theme_preset::dark;
    f32 scale = 1.0F;
    ui::hud_mode mode = ui::hud_mode::locked;
};

// NaN fails both comparisons, so it is refused too.
auto is_supported_scale(f32 scale) -> bool {
    return scale >= 0.5F && scale <= 3.0F;
}

auto argument(std::span<const wchar_t* const> args, isize index) -> std::wstring_view {
    return std::wstring_view{args.subspan(narrow<usize>(index)).front()};
}

auto theme_of(std::wstring_view name) -> std::optional<ui::theme_preset> {
    if (name == L"dark") {
        return ui::theme_preset::dark;
    }
    if (name == L"light") {
        return ui::theme_preset::light;
    }
    if (name == L"contrast") {
        return ui::theme_preset::high_contrast;
    }
    return std::nullopt;
}

auto scale_of(std::wstring_view text) -> std::optional<f32> {
    const std::string scale = to_utf8(text);
    const char* end = std::to_address(scale.end());
    f32 parsed = 0.0F;
    const std::from_chars_result read = std::from_chars(scale.data(), end, parsed);
    if (read.ec != std::errc{} || read.ptr != end || !is_supported_scale(parsed)) {
        return std::nullopt;
    }
    return parsed;
}

auto parse(std::span<const wchar_t* const> args) -> std::optional<options> {
    if (args.size() < 2) {
        return std::nullopt;
    }
    options chosen{.output = argument(args, 1)};
    const std::wstring_view what = argument(args, 0);
    if (what == L"hud") {
        chosen.shown = subject::hud;
    } else if (what != L"settings") {
        return std::nullopt;
    }
    const usize most = chosen.shown == subject::hud ? 5 : 4;
    if (args.size() > most) {
        return std::nullopt;
    }
    if (args.size() >= 3) {
        const std::optional<ui::theme_preset> theme = theme_of(argument(args, 2));
        if (!theme) {
            return std::nullopt;
        }
        chosen.theme = *theme;
    }
    if (args.size() >= 4) {
        const std::optional<f32> scale = scale_of(argument(args, 3));
        if (!scale) {
            return std::nullopt;
        }
        chosen.scale = *scale;
    }
    if (args.size() == 5) {
        const std::wstring_view mode = argument(args, 4);
        if (mode == L"arranging") {
            chosen.mode = ui::hud_mode::arranging;
        } else if (mode != L"locked") {
            return std::nullopt;
        }
    }
    return chosen;
}

auto linear(draw::color from, draw::color until, draw::vec2 start, draw::vec2 end) -> draw::paint {
    return {
        .kind = draw::paint_kind::linear,
        .from = from,
        .to = until,
        .start = start,
        .end = end,
    };
}

// A stand-in for a game's frame, in units: a sky over a bright horizon, and shapes with edges for
// the glass to blur, so the shot shows what the material does.
auto draw_scene(draw::draw_list& list, draw::vec2 viewport) -> void {
    const draw::rect whole{.min = {.x = 0.0F, .y = 0.0F}, .max = viewport};
    list.fill(
        draw::rounded_rect{.bounds = whole, .radii = draw::uniform(0.0F)},
        linear(
            {.r = 34, .g = 52, .b = 92, .a = 255},
            {.r = 236, .g = 190, .b = 132, .a = 255},
            {.x = 0.0F, .y = 0.0F},
            {.x = 0.0F, .y = viewport.y}
        )
    );
    const std::array<draw::color, 4> tints{
        draw::color{.r = 242, .g = 92, .b = 84, .a = 255},
        draw::color{.r = 94, .g = 200, .b = 128, .a = 255},
        draw::color{.r = 250, .g = 250, .b = 245, .a = 255},
        draw::color{.r = 40, .g = 40, .b = 48, .a = 255},
    };
    for (const auto [index, tint] : std::views::enumerate(tints)) {
        const f32 step = static_cast<f32>(index);
        const draw::vec2 centre{
            .x = viewport.x * (0.2F + (0.22F * step)),
            .y = viewport.y * (0.3F + (0.15F * step)),
        };
        list.fill(draw::circle{.centre = centre, .radius = viewport.x * 0.12F}, draw::solid(tint));
    }
    for (isize stripe = 0; stripe < 8; ++stripe) {
        const f32 top = viewport.y * (0.55F + (0.05F * static_cast<f32>(stripe)));
        list.fill(
            draw::rounded_rect{
                .bounds = {.min = {.x = 0.0F, .y = top}, .max = {.x = viewport.x, .y = top + 6.0F}},
                .radii = draw::uniform(0.0F),
            },
            draw::solid({.r = 20, .g = 22, .b = 30, .a = 120})
        );
    }
}

// What one frame of a shot records over the scene, given the light the glass sampled last frame.
using shot_frame =
    stdx::function_ref<result<void>(draw::draw_list&, std::optional<draw::color>, draw::vec2)>;

struct capture_target {
    d3d11::testing::warp_device* device = nullptr;
    d3d11::testing::test_target* target = nullptr;
    d3d11::renderer* renderer = nullptr;
    text::text_system* text = nullptr;
};

auto render_frames(const options& chosen, const capture_target& into, shot_frame frame)
    -> result<void> {
    draw::draw_list list;
    const draw::pixel_size size = into.target->as_render_target().size;
    const draw::vec2 viewport{
        .x = static_cast<f32>(size.width) / chosen.scale,
        .y = static_cast<f32>(size.height) / chosen.scale,
    };
    std::optional<draw::color> light;
    for (isize settle = 0; settle < settling_frames; ++settle) {
        into.text->begin_frame();
        list.reset({.size = size, .pixels_per_unit = chosen.scale});
        draw_scene(list, viewport);
        LUCENT_TRY(frame(list, light, viewport));
        into.renderer->upload_atlas(into.text->take_patches());
        LUCENT_TRY(into.renderer->render(list.frame(), into.target->as_render_target()));
        // Waits for the GPU, so the next frame finds this one's light sampled.
        LUCENT_TRY(d3d11::testing::read_back(*into.device, *into.target));
        light = into.renderer->sampled_light(menu::menu_light);
    }
    return {};
}

auto shoot_settings(const options& chosen, const capture_target& into) -> result<void> {
    const text::face_id face = LUCENT_TRY(text::add_message_font(*into.text));
    menu::table_catalog labels;
    cs2::overlay::add_dev_text(labels);
    kit::wiring wired;
    cs2::features::wire(wired);
    const kit::test_clock time;
    kit::registry features{std::move(wired), {.is_everything = true, .features = {}}, time};
    // Profiles live in memory, as the module's do: a shot writes nothing.
    kit::memory_storage kept;
    kit::config_store configs{features, kept, std::string{}};
    menu::settings_menu settings{
        *into.text, {.theme = menu::menu_theme_inputs(face, chosen.theme), .text = &labels}, configs
    };
    return render_frames(
        chosen,
        into,
        [&](draw::draw_list& list,
            std::optional<draw::color> light,
            draw::vec2 viewport) -> result<void> {
            LUCENT_TRY(settings.draw(
                {
                    .input = {},
                    .viewport = viewport,
                    .pixels_per_unit = chosen.scale,
                    .backdrop = light,
                    .system_clipboard = nullptr,
                },
                list
            ));
            return {};
        }
    );
}

// Two HUD windows a feature might show: a list and a single figure.
auto declare_hud(ui::context& frame, ui::hud_placements& placements, ui::hud_mode mode) -> void {
    ui::hud_window(
        frame,
        placements,
        {
            .key = ui::key<"spectators">(),
            .title = "Spectators",
            .position = {.x = 24.0F, .y = 120.0F},
            .width = ui::fixed(180.0F),
            .mode = mode,
        },
        [&] {
            ui::label(frame, "ropz");
            ui::label(frame, "broky");
            ui::label(frame, "frozen");
        }
    );
    ui::hud_window(
        frame,
        placements,
        {
            .key = ui::key<"bomb">(),
            .title = "Bomb",
            .position = {.x = 260.0F, .y = 40.0F},
            .width = ui::fit(),
            .mode = mode,
        },
        [&] {
            frame.text({
                .utf8 = "31.4 s  B site",
                .style = frame.tokens().type.title,
                .ink = frame.tokens().colors.ink,
                .wrap = text::text_wrap::none,
                .overflow = text::text_overflow::visible,
                .max_lines = std::nullopt,
            });
        }
    );
}

auto shoot_hud(const options& chosen, const capture_target& into) -> result<void> {
    const text::face_id face = LUCENT_TRY(text::add_message_font(*into.text));
    const ui::theme tokens = ui::derive_theme(menu::menu_theme_inputs(face, chosen.theme));
    ui::context frame{*into.text};
    ui::hud_placements placements;
    return render_frames(
        chosen,
        into,
        [&](draw::draw_list& list,
            std::optional<draw::color> /*light*/,
            draw::vec2 viewport) -> result<void> {
            ui::frame_input still;
            still.tokens = tokens;
            still.viewport = viewport;
            still.pixels_per_unit = chosen.scale;
            frame.begin_frame(std::move(still));
            declare_hud(frame, placements, chosen.mode);
            LUCENT_TRY(frame.end_frame());
            return frame.record(list);
        }
    );
}

auto capture(const options& chosen) -> result<void> {
    const draw::vec2 units = chosen.shown == subject::settings
                                 ? draw::vec2{.x = 512.0F, .y = 768.0F}
                                 : draw::vec2{.x = 512.0F, .y = 320.0F};
    const draw::pixel_size size{
        .width = static_cast<i32>(std::ceil(units.x * chosen.scale)),
        .height = static_cast<i32>(std::ceil(units.y * chosen.scale)),
    };
    d3d11::testing::warp_device device = LUCENT_TRY(d3d11::testing::warp_device::create());
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
    // A frame or two of the whole run share a frame budget, so every glyph is rasterized.
    text::text_system text = LUCENT_TRY(
        text::text_system::create({.raster_budget = 4096, .layout_lifetime = 8, .atlas = {}})
    );
    const capture_target into{
        .device = &device,
        .target = &target,
        .renderer = &renderer,
        .text = &text,
    };
    if (chosen.shown == subject::settings) {
        LUCENT_TRY(shoot_settings(chosen, into));
    } else {
        LUCENT_TRY(shoot_hud(chosen, into));
    }
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
