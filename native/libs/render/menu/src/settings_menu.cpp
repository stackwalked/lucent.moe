#include <lucent/menu/settings_menu.hpp>

#include <algorithm>
#include <optional>
#include <utility>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/config_store.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/menu/page.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::menu {
namespace {

constexpr draw::color accent{.r = 255, .g = 0, .b = 153, .a = 255};
// Below the dev demo's line, which sits at the top left.
constexpr draw::vec2 window_origin{.x = 24.0F, .y = 96.0F};
constexpr f32 window_width = 440.0F;
constexpr f32 tallest_window = 640.0F;
constexpr f32 shortest_window = 160.0F;

// As tall as the page wants up to tallest_window, and never past the viewport's bottom margin.
auto window_height(draw::vec2 viewport) -> f32 {
    const f32 room = viewport.y - window_origin.y - window_origin.x;
    return std::max(std::min(tallest_window, room), shortest_window);
}

}

auto menu_theme_inputs(text::face_id face, ui::theme_preset preset) -> ui::theme_inputs {
    return {
        .accent = accent,
        .preset = preset,
        .scale = 1.0F,
        .is_reduced_motion = false,
        .backdrop = std::nullopt,
        .text_face = face,
        .numeric_face = face,
    };
}

settings_menu::settings_menu(
    text::text_system& text, menu_appearance appearance, kit::config_store& configs
)
    : m_ui{text}
    , m_inputs{appearance.theme}
    , m_tokens{ui::derive_theme(appearance.theme)}
    , m_text{appearance.text}
    , m_features{&configs.features()}
    , m_configs{&configs} {
    LUCENT_INVARIANT(m_text != nullptr);
}

auto settings_menu::take_keys(kit::key_input keys) -> void {
    m_keys = std::move(keys);
}

auto settings_menu::draw(menu_frame frame, draw::draw_list& list) -> result<ui::frame_report> {
    ui::theme_inputs wanted = m_inputs;
    wanted.backdrop = frame.backdrop;
    if (!ui::is_unchanged(m_inputs, wanted)) {
        m_inputs = wanted;
        m_tokens = ui::derive_theme(m_inputs);
    }
    m_ui.begin_frame({
        .input = std::move(frame.input),
        .tokens = m_tokens,
        .viewport = frame.viewport,
        .pixels_per_unit = frame.pixels_per_unit,
        .system_clipboard = frame.system_clipboard,
    });
    page_outcome outcome = declare(frame.viewport);
    const ui::frame_report report = LUCENT_TRY(m_ui.end_frame());
    LUCENT_TRY(m_ui.record(list));
    m_query = std::move(outcome.query);
    m_binding = outcome.binding;
    m_keys.changes.clear();
    if (outcome.changes.empty()) {
        return report;
    }
    m_configs->edit(outcome.changes);
    return report;
}

auto settings_menu::declare(draw::vec2 viewport) -> page_outcome {
    const kit::published<kit::registry_snapshot>::reading shown = m_features->read();
    const page_input input{
        .snapshot = &*shown,
        .text = m_text,
        .query = m_query,
        .binding = m_binding,
        .keys = m_keys.changes,
    };
    const ui::box_style window{
        .flow = ui::direction::column,
        .width = ui::fixed(window_width),
        .height = ui::fixed(window_height(viewport)),
        .padding = ui::even(m_tokens.spacing.l),
        .gap = 0.0F,
        .main = ui::main_align::start,
        .cross = ui::cross_align::stretch,
        .look = ui::glass_decoration(m_tokens.materials.glass, menu_light),
    };
    // Clear of the rail, which takes presses along the scroll's right edge.
    const ui::box_style scrolled{
        .flow = ui::direction::column,
        .width = ui::grow(),
        .height = ui::grow(),
        .padding =
            {.left = 0.0F, .top = 0.0F, .right = m_tokens.controls.rail_reach, .bottom = 0.0F},
        .gap = 0.0F,
        .main = ui::main_align::start,
        .cross = ui::cross_align::stretch,
    };
    page_outcome outcome;
    m_ui.window({.key = ui::key<"menu">(), .position = window_origin, .style = window}, [&] {
        m_ui.scroll(ui::key<"scroll">(), scrolled, [&] {
            outcome = settings_page(m_ui, ui::key<"page">(), input);
        });
    });
    return outcome;
}

}
