#include <lucent/cs2-overlay/input_feed.hpp>

#include <algorithm>
#include <iterator>
#include <optional>
#include <ranges>
#include <utility>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/ui/input_snapshot.hpp>

namespace lucent::cs2::overlay {
namespace {

auto button_of(ui::input_snapshot& input, mouse_button button) -> ui::button_input& {
    switch (button) {
    case mouse_button::left:
        return input.left;
    case mouse_button::right:
        return input.right;
    case mouse_button::middle:
        return input.middle;
    }
    LUCENT_UNREACHABLE();
}

auto ratio(f32 units, f32 pixels) -> f32 {
    return pixels > 0.0F ? units / pixels : 1.0F;
}

// The cursor in the viewport's units; absent outside it.
auto placed(draw::vec2 cursor, const frame_place& place) -> std::optional<draw::vec2> {
    const draw::vec2 scaled{
        .x = cursor.x * ratio(place.viewport.x, place.client_size.x),
        .y = cursor.y * ratio(place.viewport.y, place.client_size.y),
    };
    const bool is_inside = scaled.x >= 0.0F
                           && scaled.y >= 0.0F
                           && scaled.x < place.viewport.x
                           && scaled.y < place.viewport.y;
    return is_inside ? std::optional{scaled} : std::nullopt;
}

auto add_event(ui::input_snapshot& input, const input_event& event) -> void {
    match(
        event,
        [&input](const button_press& press) {
            // A second press in one frame is the later click of a double click: its count wins.
            button_of(input, press.button).click_count = press.click_count;
        },
        [&input](const button_release& release) {
            button_of(input, release.button).is_released = true;
        },
        [&input](const wheel_turn& turn) { input.wheel = input.wheel + turn.notches; },
        [&input](const ui::key_event& key) { input.keyboard.emplace_back(key); },
        [&input](const ui::typed_text& typed) { input.keyboard.emplace_back(typed); },
        [&input](const ui::composition& update) { input.keyboard.emplace_back(update); }
    );
}

}

auto snapshot_of(const input_feed& feed, u64 consumed, const frame_place& place) -> frame_snapshot {
    ui::input_snapshot input;
    input.time = place.time;
    input.modifiers = feed.modifiers;
    if (feed.cursor) {
        input.cursor = placed(*feed.cursor, place);
    }
    for (const auto [index, is_held] : std::views::enumerate(feed.buttons)) {
        button_of(input, static_cast<mouse_button>(narrow<u8>(index))).is_down = is_held;
    }
    for (const sequenced_event& recorded : feed.events) {
        if (recorded.serial > consumed) {
            add_event(input, recorded.event);
        }
    }
    return {.input = std::move(input), .consumed = feed.serial};
}

auto key_input_of(const key_tally& now, const key_tally& taken) -> kit::key_input {
    kit::key_input changed;
    for (const auto [index, is_down] : std::views::enumerate(now.is_down)) {
        const auto code = narrow<usize>(index);
        const kit::input_key key{narrow<u8>(index)};
        const u32 presses = now.presses.at(code) - taken.presses.at(code);
        bool is_held = taken.is_down.at(code);
        const u32 replayed = presses == 0 ? 0 : 2 - (presses % 2);
        for (u32 press = 0; press < replayed; ++press) {
            if (is_held) {
                changed.changes.push_back({.key = key, .is_down = false});
            }
            changed.changes.push_back({.key = key, .is_down = true});
            is_held = true;
        }
        if (is_held != is_down) {
            changed.changes.push_back({.key = key, .is_down = is_down});
        }
    }
    return changed;
}

auto releases_of(const kit::key_input& keys) -> kit::key_input {
    kit::key_input released;
    std::ranges::copy_if(
        keys.changes, std::back_inserter(released.changes), [](const kit::key_change& changed) {
            return !changed.is_down;
        }
    );
    return released;
}

}
