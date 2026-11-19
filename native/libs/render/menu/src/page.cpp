#include <lucent/menu/page.hpp>

#include <algorithm>
#include <array>
#include <concepts>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/menu/catalog.hpp>
#include <lucent/menu/text_key.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/button.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/dropdown.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/slider.hpp>
#include <lucent/ui/theme.hpp>
#include <lucent/ui/toggle.hpp>

#include "color_swatch.hpp"
#include "search_field.hpp"

namespace lucent::menu {
namespace {

auto folded(char unit) -> char {
    return unit >= 'A' && unit <= 'Z' ? static_cast<char>(unit - 'A' + 'a') : unit;
}

// Whether label holds query, ignoring ASCII case; other text compares byte for byte.
auto is_match(std::string_view label, std::string_view query) -> bool {
    if (query.empty()) {
        return true;
    }
    return !std::ranges::search(label, query, {}, folded, folded).empty();
}

// A feature as the page shows it.
struct shown_feature {
    const kit::feature_snapshot* snapshot = nullptr;
    std::string label;
    // Its label holds the query, so every setting it has is shown.
    bool is_matched = false;
};

// One setting as the page shows it: its description, its value in the snapshot, its label.
struct shown_setting {
    kit::feature_id feature{};
    const kit::setting_description* description = nullptr;
    const kit::setting_value* value = nullptr;
    std::string label;
};

// What the page is declaring from, and the edits it has collected so far.
struct page_build {
    const page_input* input = nullptr;
    // The query after this frame's typing: the search field is declared first, so the rows below
    // it filter by what was just typed.
    std::string query;
    std::vector<kit::registry_change> changes;
    std::optional<kit::feature_id> binding;
};

auto line_text(ui::context& frame, std::string_view utf8, draw::color ink) -> void {
    frame.text({
        .utf8 = utf8,
        .style = frame.tokens().type.body,
        .ink = ink,
        .wrap = text::text_wrap::none,
        .overflow = text::text_overflow::ellipsis,
        .max_lines = 1,
    });
}

auto status_phrase(kit::feature_state state) -> phrase_id {
    switch (state) {
    case kit::feature_state::unavailable:
        return phrases::unavailable;
    case kit::feature_state::unentitled:
        return phrases::unentitled;
    case kit::feature_state::failed:
        return phrases::failed;
    case kit::feature_state::lapsed:
        return phrases::lapsed;
    case kit::feature_state::off:
    case kit::feature_state::on:
        // A switch shows these.
        LUCENT_UNREACHABLE();
    }
    LUCENT_UNREACHABLE();
}

// A feature that can't be switched: its label, why, and for a failed one the reset.
auto status_row(ui::context& frame, page_build& build, const shown_feature& feature) -> void {
    const kit::feature_snapshot& shown = *feature.snapshot;
    const ui::theme& tokens = frame.tokens();
    const catalog& text = *build.input->text;
    const bool is_failed = shown.state == kit::feature_state::failed;
    const std::string why = text_of(text, phrase_text{status_phrase(shown.state)});
    const ui::box_style row{
        .flow = ui::direction::row,
        .width = ui::grow(),
        .height = ui::fixed(tokens.controls.height),
        .padding = ui::symmetric(tokens.spacing.m, 0.0F),
        .gap = tokens.spacing.m,
        .main = ui::main_align::start,
        .cross = ui::cross_align::center,
    };
    frame.box(ui::key<"status">(), row, [&] {
        line_text(frame, feature.label, tokens.colors.muted_ink);
        line_text(frame, why, is_failed ? tokens.colors.danger : tokens.colors.muted_ink);
        if (!is_failed) {
            return;
        }
        const std::string reset = text_of(text, phrase_text{phrases::reset});
        if (ui::button(frame, ui::key<"reset">(), reset).is_activated) {
            build.changes.emplace_back(kit::reset_feature{.feature = shown.id});
        }
    });
}

// The first key pressed this frame, which a waiting bind takes.
auto first_press(std::span<const kit::key_change> keys) -> std::optional<kit::input_key> {
    const auto found = std::ranges::find(keys, true, &kit::key_change::is_down);
    return found == keys.end() ? std::nullopt : std::optional{found->key};
}

// A waiting bind takes this frame's first press: Escape keeps the old key, any other is the new
// one. A key set on an always bind makes it hold, since an always bind would ignore it.
auto take_key(page_build& build, const kit::feature_snapshot& shown) -> void {
    if (build.input->binding != shown.id) {
        return;
    }
    const std::optional<kit::input_key> pressed = first_press(build.input->keys);
    if (!pressed) {
        return;
    }
    build.binding.reset();
    if (*pressed == kit::escape_key) {
        return;
    }
    const kit::bind_mode mode =
        shown.bind.mode == kit::bind_mode::always ? kit::bind_mode::hold : shown.bind.mode;
    build.changes.emplace_back(
        kit::change_bind{.feature = shown.id, .bind = {.mode = mode, .key = pressed}}
    );
}

auto key_label(const page_build& build, const kit::feature_snapshot& shown) -> std::string {
    const catalog& text = *build.input->text;
    if (build.binding == shown.id) {
        return text_of(text, phrase_text{phrases::press_key});
    }
    if (!shown.bind.key) {
        return text_of(text, phrase_text{phrases::no_key});
    }
    return text_of(text, key_text{*shown.bind.key});
}

auto bind_mode_control(ui::context& frame, page_build& build, const kit::feature_snapshot& shown)
    -> void {
    const catalog& text = *build.input->text;
    const std::array<std::string, 3> modes{
        text_of(text, phrase_text{phrases::always}),
        text_of(text, phrase_text{phrases::hold}),
        text_of(text, phrase_text{phrases::toggle}),
    };
    const std::array<std::string_view, 3> options{modes[0], modes[1], modes[2]};
    const std::optional<isize> chosen = ui::dropdown(
        frame,
        ui::key<"mode">(),
        {.options = options, .selected = isize{std::to_underlying(shown.bind.mode)}}
    );
    if (!chosen) {
        return;
    }
    const kit::bind_slot bind{
        .mode = static_cast<kit::bind_mode>(narrow<u8>(*chosen)),
        .key = shown.bind.key,
    };
    build.changes.emplace_back(kit::change_bind{.feature = shown.id, .bind = bind});
}

// The feature's bind: a dropdown of its mode, and a button showing its key that waits for a new
// one when clicked.
auto bind_row(ui::context& frame, page_build& build, const kit::feature_snapshot& shown) -> void {
    take_key(build, shown);
    const ui::theme& tokens = frame.tokens();
    const catalog& text = *build.input->text;
    const ui::box_style row{
        .flow = ui::direction::row,
        .width = ui::grow(),
        .height = ui::fit(),
        .padding = ui::symmetric(tokens.spacing.m, 0.0F),
        .gap = tokens.spacing.m,
        .main = ui::main_align::start,
        .cross = ui::cross_align::center,
    };
    frame.box(ui::key<"bind">(), row, [&] {
        line_text(frame, text_of(text, phrase_text{phrases::bind}), tokens.colors.ink);
        bind_mode_control(frame, build, shown);
        const bool is_binding = build.binding == shown.id;
        if (ui::button(frame, ui::key<"key">(), key_label(build, shown)).is_activated) {
            build.binding = is_binding ? std::nullopt : std::optional{shown.id};
        }
    });
}

auto feature_header(ui::context& frame, page_build& build, const shown_feature& feature) -> void {
    const kit::feature_snapshot& shown = *feature.snapshot;
    switch (shown.state) {
    case kit::feature_state::off:
    case kit::feature_state::on: {
        const bool is_on = shown.state == kit::feature_state::on;
        const std::optional<bool> flipped =
            ui::toggle(frame, ui::key<"switch">(), {.caption = feature.label, .is_on = is_on});
        if (flipped == true) {
            build.changes.emplace_back(kit::enable_feature{.feature = shown.id});
        }
        if (flipped == false) {
            build.changes.emplace_back(kit::disable_feature{.feature = shown.id});
        }
        bind_row(frame, build, shown);
        return;
    }
    case kit::feature_state::unavailable:
    case kit::feature_state::unentitled:
    case kit::feature_state::failed:
    case kit::feature_state::lapsed:
        status_row(frame, build, feature);
        return;
    }
}

template <std::copyable T>
auto value_as(const shown_setting& setting) -> T {
    const std::optional<T> value = kit::held<T>(*setting.value);
    LUCENT_INVARIANT(value.has_value());
    return *value;
}

auto option_labels(
    const catalog& text, setting_place place, std::span<const kit::setting_id> options
) -> std::vector<std::string> {
    std::vector<std::string> labels;
    labels.reserve(options.size());
    for (const kit::setting_id option : options) {
        labels.push_back(text_of(
            text, option_text{.feature = place.feature, .setting = place.setting, .option = option}
        ));
    }
    return labels;
}

auto choice_control(ui::context& frame, const catalog& text, const shown_setting& setting)
    -> std::optional<isize> {
    const kit::setting_description& described = *setting.description;
    const std::vector<std::string> labels = option_labels(
        text, {.feature = setting.feature, .setting = described.id}, described.options
    );
    const std::vector<std::string_view> options{labels.begin(), labels.end()};
    line_text(frame, setting.label, frame.tokens().colors.ink);
    return ui::dropdown(
        frame, ui::key<"control">(), {.options = options, .selected = value_as<isize>(setting)}
    );
}

auto color_control(ui::context& frame, const catalog& text, const shown_setting& setting)
    -> std::optional<kit::color> {
    const std::array<std::string, 4> channels{
        text_of(text, phrase_text{phrases::red}),
        text_of(text, phrase_text{phrases::green}),
        text_of(text, phrase_text{phrases::blue}),
        text_of(text, phrase_text{phrases::alpha}),
    };
    line_text(frame, setting.label, frame.tokens().colors.ink);
    return detail::color_swatch(
        frame,
        ui::key<"control">(),
        {
            .value = value_as<kit::color>(setting),
            .channels = {channels[0], channels[1], channels[2], channels[3]},
        }
    );
}

template <std::copyable T>
auto as_setting_value(const std::optional<T>& edited) -> std::optional<kit::setting_value> {
    return edited ? std::optional{kit::setting_value{*edited}} : std::nullopt;
}

// The setting's control, by its kind; the value it was edited to this frame.
auto setting_control(ui::context& frame, const catalog& text, const shown_setting& setting)
    -> std::optional<kit::setting_value> {
    const kit::setting_description& described = *setting.description;
    switch (described.kind) {
    case kit::setting_kind::toggle:
        return as_setting_value(
            ui::toggle(
                frame,
                ui::key<"control">(),
                {.caption = setting.label, .is_on = value_as<bool>(setting)}
            )
        );
    case kit::setting_kind::number:
        return as_setting_value(
            ui::slider(
                frame,
                ui::key<"control">(),
                {
                    .caption = setting.label,
                    .value = value_as<f32>(setting),
                    .min = described.range.min,
                    .max = described.range.max,
                    .step = described.range.step,
                }
            )
        );
    case kit::setting_kind::choice:
        return as_setting_value(choice_control(frame, text, setting));
    case kit::setting_kind::color:
        return as_setting_value(color_control(frame, text, setting));
    }
    LUCENT_UNREACHABLE();
}

// Toggles and sliders lay out their own caption; a dropdown or a swatch sits beside the label the
// row draws, padded as a toggle pads its caption.
auto setting_row_style(const ui::theme& tokens, kit::setting_kind kind) -> ui::box_style {
    const bool is_labelled_by_row =
        kind == kit::setting_kind::choice || kind == kit::setting_kind::color;
    return {
        .flow = ui::direction::row,
        .width = ui::grow(),
        .height = ui::fit(),
        .padding = is_labelled_by_row ? ui::symmetric(tokens.spacing.m, 0.0F) : ui::even(0.0F),
        .gap = tokens.spacing.m,
        .main = is_labelled_by_row ? ui::main_align::space_between : ui::main_align::start,
        .cross = ui::cross_align::center,
    };
}

auto setting_row(ui::context& frame, page_build& build, const shown_setting& setting) -> void {
    const kit::setting_id id = setting.description->id;
    frame.box(
        ui::local_key{std::to_underlying(id)},
        setting_row_style(frame.tokens(), setting.description->kind),
        [&] {
            const std::optional<kit::setting_value> edited =
                setting_control(frame, *build.input->text, setting);
            if (edited) {
                build.changes.emplace_back(
                    kit::change_setting{
                        .feature = setting.feature,
                        .setting = id,
                        .value = *edited,
                    }
                );
            }
        }
    );
}

// Its settings paired with their values and labelled: those the query finds, or all of them when
// the feature's own label holds it.
auto shown_settings(const page_build& build, const shown_feature& feature)
    -> std::vector<shown_setting> {
    const kit::feature_snapshot& shown = *feature.snapshot;
    LUCENT_INVARIANT(std::ssize(shown.descriptions) == std::ssize(shown.settings));
    std::vector<shown_setting> settings;
    for (const auto [index, description] : std::views::enumerate(shown.descriptions)) {
        std::string label = text_of(
            *build.input->text, setting_text{.feature = shown.id, .setting = description.id}
        );
        if (!feature.is_matched && !is_match(label, build.query)) {
            continue;
        }
        settings.push_back({
            .feature = shown.id,
            .description = &description,
            .value = &shown.settings.at(narrow<usize>(index)),
            .label = std::move(label),
        });
    }
    return settings;
}

auto feature_section(ui::context& frame, page_build& build, const kit::feature_snapshot& shown)
    -> void {
    std::string label = text_of(*build.input->text, feature_text{shown.id});
    const bool is_matched = is_match(label, build.query);
    const shown_feature feature{
        .snapshot = &shown,
        .label = std::move(label),
        .is_matched = is_matched,
    };
    const std::vector<shown_setting> settings = shown_settings(build, feature);
    if (!feature.is_matched && settings.empty()) {
        return;
    }
    const ui::theme& tokens = frame.tokens();
    const ui::box_style section{
        .flow = ui::direction::column,
        .width = ui::grow(),
        .height = ui::fit(),
        .gap = tokens.spacing.xs,
        .main = ui::main_align::start,
        .cross = ui::cross_align::stretch,
    };
    frame.box(ui::local_key{std::to_underlying(shown.id)}, section, [&] {
        feature_header(frame, build, feature);
        for (const shown_setting& setting : settings) {
            setting_row(frame, build, setting);
        }
    });
}

}

auto settings_page(ui::context& frame, ui::local_key key, const page_input& input) -> page_outcome {
    LUCENT_INVARIANT(input.snapshot != nullptr && input.text != nullptr);
    const ui::theme& tokens = frame.tokens();
    page_build build{.input = &input, .query = {}, .changes = {}, .binding = input.binding};
    const ui::box_style page{
        .flow = ui::direction::column,
        .width = ui::grow(),
        .height = ui::fit(),
        .gap = tokens.spacing.s,
        .main = ui::main_align::start,
        .cross = ui::cross_align::stretch,
    };
    frame.box(key, page, [&] {
        const std::string hint = text_of(*input.text, phrase_text{phrases::search});
        build.query =
            detail::search_field(frame, ui::key<"search">(), {.query = input.query, .hint = hint});
        for (const kit::feature_snapshot& shown : input.snapshot->features) {
            feature_section(frame, build, shown);
        }
    });
    return {
        .changes = std::move(build.changes),
        .query = std::move(build.query),
        .binding = build.binding,
    };
}

}
