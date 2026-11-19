#include <lucent/menu/settings_menu.hpp>

#include <algorithm>
#include <utility>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
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

auto plate_look(const ui::theme& tokens) -> ui::decoration {
    const ui::plate_material& plate = tokens.materials.plate;
    return {
        .fill = draw::solid(plate.fill),
        .radius = plate.radius,
        .outline = plate.rim,
        .outline_width = plate.rim_width,
        .shadow = plate.shadow,
    };
}

// As tall as the page wants up to tallest_window, and never past the viewport's bottom margin.
auto window_height(draw::vec2 viewport) -> f32 {
    const f32 room = viewport.y - window_origin.y - window_origin.x;
    return std::max(std::min(tallest_window, room), shortest_window);
}

}

auto menu_theme(text::face_id face, ui::theme_preset preset) -> ui::theme {
    return ui::derive_theme({
        .accent = accent,
        .preset = preset,
        .scale = 1.0F,
        .is_reduced_motion = false,
        .text_face = face,
        .numeric_face = face,
    });
}

settings_menu::settings_menu(
    text::text_system& text, menu_appearance appearance, kit::registry& features
)
    : m_ui{text}
    , m_tokens{appearance.tokens}
    , m_text{appearance.text}
    , m_features{&features} {
    LUCENT_INVARIANT(m_text != nullptr);
}

settings_menu::settings_menu(
    text::text_system& text, menu_appearance appearance, kit::config_store& configs
)
    : settings_menu{text, appearance, configs.features()} {
    m_configs = &configs;
}

auto settings_menu::take_keys(kit::key_input keys) -> void {
    m_keys = std::move(keys);
}

auto settings_menu::draw(menu_frame frame, draw::draw_list& list) -> result<ui::frame_report> {
    m_ui.begin_frame({
        .input = std::move(frame.input),
        .tokens = m_tokens,
        .viewport = frame.viewport,
        .pixels_per_unit = frame.pixels_per_unit,
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
    if (m_configs != nullptr) {
        m_configs->edit(outcome.changes);
    } else {
        m_features->request(std::move(outcome.changes));
    }
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
        .look = plate_look(m_tokens),
    };
    const ui::box_style scrolled{
        .flow = ui::direction::column,
        .width = ui::grow(),
        .height = ui::grow(),
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
