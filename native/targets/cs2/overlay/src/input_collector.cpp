#include <lucent/cs2-overlay/input_collector.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <optional>
#include <ranges>
#include <string>
#include <utility>

#include <Windows.h>

#include <lucent/core/flags.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/input_snapshot.hpp>

namespace lucent::cs2::overlay {
namespace {

// The menu's key until binds land: Insert, which cs2's default config binds to nothing.
constexpr u64 menu_virtual_key = VK_INSERT;

// Events the presenting thread hasn't taken yet: it takes them every frame it draws the menu, so
// only an overlay that stopped drawing lets them pile up, and then the oldest go.
constexpr isize max_events = 1024;

struct mapped_key {
    u64 virtual_key = 0;
    ui::key_code code = ui::key_code::tab;
};

constexpr std::array mapped_keys{
    mapped_key{.virtual_key = VK_TAB, .code = ui::key_code::tab},
    mapped_key{.virtual_key = VK_RETURN, .code = ui::key_code::enter},
    mapped_key{.virtual_key = VK_SPACE, .code = ui::key_code::space},
    mapped_key{.virtual_key = VK_ESCAPE, .code = ui::key_code::escape},
    mapped_key{.virtual_key = VK_BACK, .code = ui::key_code::backspace},
    mapped_key{.virtual_key = VK_DELETE, .code = ui::key_code::forward_delete},
    mapped_key{.virtual_key = VK_LEFT, .code = ui::key_code::left},
    mapped_key{.virtual_key = VK_RIGHT, .code = ui::key_code::right},
    mapped_key{.virtual_key = VK_UP, .code = ui::key_code::up},
    mapped_key{.virtual_key = VK_DOWN, .code = ui::key_code::down},
    mapped_key{.virtual_key = VK_HOME, .code = ui::key_code::home},
    mapped_key{.virtual_key = VK_END, .code = ui::key_code::end},
    mapped_key{.virtual_key = VK_PRIOR, .code = ui::key_code::page_up},
    mapped_key{.virtual_key = VK_NEXT, .code = ui::key_code::page_down},
    // Letter keys' virtual codes are their upper case ASCII.
    mapped_key{.virtual_key = 'A', .code = ui::key_code::letter_a},
    mapped_key{.virtual_key = 'C', .code = ui::key_code::letter_c},
    mapped_key{.virtual_key = 'V', .code = ui::key_code::letter_v},
    mapped_key{.virtual_key = 'X', .code = ui::key_code::letter_x},
    mapped_key{.virtual_key = 'Y', .code = ui::key_code::letter_y},
    mapped_key{.virtual_key = 'Z', .code = ui::key_code::letter_z},
};

auto key_code_of(u64 virtual_key) -> std::optional<ui::key_code> {
    const auto found = std::ranges::find(mapped_keys, virtual_key, &mapped_key::virtual_key);
    return found == mapped_keys.end() ? std::nullopt : std::optional{found->code};
}

// A 16-bit field of a message parameter, read as the signed value Win32 packs there.
auto signed_word(u64 bits, u32 shift) -> f32 {
    return static_cast<f32>(std::bit_cast<i16>(static_cast<u16>((bits >> shift) & 0xffffU)));
}

// Client coordinates, as mouse messages other than the wheel's pack them.
auto cursor_of(const window_message& message) -> draw::vec2 {
    const auto bits = std::bit_cast<u64>(message.lparam);
    return {.x = signed_word(bits, 0), .y = signed_word(bits, 16)};
}

auto notches_of(const window_message& message) -> f32 {
    return signed_word(message.wparam, 16) / static_cast<f32>(WHEEL_DELTA);
}

// Bit 30 of a key message's lparam: the key was already down, so this is the keyboard's repeat.
auto is_repeat(const window_message& message) -> bool {
    return (std::bit_cast<u64>(message.lparam) & (1ULL << 30U)) != 0;
}

auto is_high_surrogate(u16 unit) -> bool {
    return unit >= 0xd800U && unit <= 0xdbffU;
}

auto is_low_surrogate(u16 unit) -> bool {
    return unit >= 0xdc00U && unit <= 0xdfffU;
}

// Backspace, Tab, Enter and Escape reach the UI as keys; their characters are dropped.
auto is_control_unit(u16 unit) -> bool {
    return unit < 0x20U || unit == 0x7fU;
}

struct modifier_key {
    u64 virtual_key = 0;
    ui::modifier modifier = ui::modifier::shift;
};

// Key messages name the side-less keys; Alt comes as a system key.
constexpr std::array<modifier_key, modifier_count> modifier_keys{
    modifier_key{.virtual_key = VK_SHIFT, .modifier = ui::modifier::shift},
    modifier_key{.virtual_key = VK_CONTROL, .modifier = ui::modifier::control},
    modifier_key{.virtual_key = VK_MENU, .modifier = ui::modifier::alt},
};

auto modifier_index(u64 virtual_key) -> std::optional<usize> {
    const auto found = std::ranges::find(modifier_keys, virtual_key, &modifier_key::virtual_key);
    if (found == modifier_keys.end()) {
        return std::nullopt;
    }
    return narrow<usize>(found - modifier_keys.begin());
}

auto held_flags(const std::array<bool, modifier_count>& held) -> flags<ui::modifier> {
    flags<ui::modifier> modifiers = ui::no_modifiers;
    for (const auto [index, is_held] : std::views::enumerate(held)) {
        if (is_held) {
            modifiers = modifiers | modifier_keys.at(narrow<usize>(index)).modifier;
        }
    }
    return modifiers;
}

// The high word of an X button message's wparam names the button.
auto side_button_of(const window_message& message) -> u64 {
    return ((message.wparam >> 16U) & 0xffffU) == XBUTTON2 ? VK_XBUTTON2 : VK_XBUTTON1;
}

auto index_of(mouse_button button) -> usize {
    return std::to_underlying(button);
}

}

auto kind_of(const window_message& message) -> message_kind {
    switch (message.id) {
    case WM_MOUSEMOVE:
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
    case WM_RBUTTONDOWN:
    case WM_RBUTTONDBLCLK:
    case WM_MBUTTONDOWN:
    case WM_MBUTTONDBLCLK:
    case WM_XBUTTONDOWN:
    case WM_XBUTTONDBLCLK:
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL:
        return message_kind::mouse;
    case WM_KEYDOWN:
    case WM_KEYUP:
        if (message.wparam == menu_virtual_key) {
            return message_kind::menu_key;
        }
        return message.id == WM_KEYDOWN ? message_kind::keyboard : message_kind::other;
    case WM_CHAR:
    case WM_DEADCHAR:
    case WM_IME_STARTCOMPOSITION:
    case WM_IME_COMPOSITION:
    case WM_IME_ENDCOMPOSITION:
    case WM_IME_CHAR:
        return message_kind::keyboard;
    default:
        return message_kind::other;
    }
}

input_collector::input_collector(click_rules rules)
    : m_rules{rules} {}

auto input_collector::record(const window_message& message) -> void {
    tally(message);
    switch (message.id) {
    case WM_MOUSEMOVE:
        m_feed.cursor = cursor_of(message);
        return;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        press(mouse_button::left, message);
        return;
    case WM_RBUTTONDOWN:
    case WM_RBUTTONDBLCLK:
        press(mouse_button::right, message);
        return;
    case WM_MBUTTONDOWN:
    case WM_MBUTTONDBLCLK:
        press(mouse_button::middle, message);
        return;
    case WM_LBUTTONUP:
        release(mouse_button::left);
        return;
    case WM_RBUTTONUP:
        release(mouse_button::right);
        return;
    case WM_MBUTTONUP:
        release(mouse_button::middle);
        return;
    case WM_MOUSEWHEEL:
        add_event(wheel_turn{.notches = {.x = 0.0F, .y = notches_of(message)}});
        return;
    case WM_MOUSEHWHEEL:
        add_event(wheel_turn{.notches = {.x = notches_of(message), .y = 0.0F}});
        return;
    case WM_KEYDOWN:
        key_down(message);
        return;
    case WM_KEYUP:
        key_up(message);
        return;
    case WM_SYSKEYDOWN:
        hold_modifier(message.wparam);
        return;
    case WM_SYSKEYUP:
        drop_modifier(message.wparam);
        return;
    case WM_CHAR:
        type(static_cast<u16>(message.wparam & 0xffffU));
        return;
    case WM_KILLFOCUS:
        lose_focus();
        return;
    case WM_ACTIVATEAPP:
        if (message.wparam == 0) {
            lose_focus();
        }
        return;
    default:
        return;
    }
}

auto input_collector::record_composition(const ui::composition& update) -> void {
    add_event(update);
}

auto input_collector::record_commit(std::string utf8) -> void {
    if (!utf8.empty()) {
        add_event(ui::typed_text{.utf8 = std::move(utf8)});
    }
}

auto input_collector::acknowledge(const menu_report& report) -> void {
    std::erase_if(m_feed.events, [&report](const sequenced_event& recorded) {
        return recorded.serial <= report.consumed;
    });
    if (m_feed.is_menu_open && report.consumed >= m_opened_at) {
        m_wanted = report;
    }
}

auto input_collector::should_keep_from_game(message_kind kind) const -> bool {
    switch (kind) {
    case message_kind::other:
        return false;
    case message_kind::menu_key:
        return true;
    case message_kind::mouse:
        return m_feed.is_menu_open && m_wanted.wants_mouse;
    case message_kind::keyboard:
        return m_feed.is_menu_open && m_wanted.wants_keyboard;
    }
    LUCENT_UNREACHABLE();
}

auto input_collector::feed() const -> const input_feed& {
    return m_feed;
}

auto input_collector::add_event(input_event event) -> void {
    if (!m_feed.is_menu_open) {
        return;
    }
    if (std::ssize(m_feed.events) >= max_events) {
        m_feed.events.erase(m_feed.events.begin());
    }
    ++m_feed.serial;
    m_feed.events.push_back({.serial = m_feed.serial, .event = std::move(event)});
}

auto input_collector::press(mouse_button button, const window_message& message) -> void {
    const draw::vec2 position = cursor_of(message);
    m_feed.cursor = position;
    m_feed.buttons.at(index_of(button)) = true;
    // Counted here rather than from double-click messages, which only windows of a class with
    // CS_DBLCLKS get.
    const bool is_repeat_click =
        m_last_press
        && m_last_press->button == button
        && message.time - m_last_press->time <= static_cast<u32>(m_rules.interval.count())
        && std::abs(position.x - m_last_press->position.x) <= m_rules.area.x / 2.0F
        && std::abs(position.y - m_last_press->position.y) <= m_rules.area.y / 2.0F;
    const i32 click_count = is_repeat_click ? m_last_press->click_count + 1 : 1;
    m_last_press = last_press{
        .button = button,
        .time = message.time,
        .position = position,
        .click_count = click_count,
    };
    add_event(button_press{.button = button, .click_count = click_count});
}

auto input_collector::release(mouse_button button) -> void {
    if (!m_feed.buttons.at(index_of(button))) {
        return;
    }
    m_feed.buttons.at(index_of(button)) = false;
    add_event(button_release{.button = button});
}

auto input_collector::key_down(const window_message& message) -> void {
    if (message.wparam == menu_virtual_key) {
        if (!is_repeat(message)) {
            toggle_menu();
        }
        return;
    }
    hold_modifier(message.wparam);
    if (const std::optional<ui::key_code> code = key_code_of(message.wparam)) {
        const ui::key_action action =
            is_repeat(message) ? ui::key_action::repeated : ui::key_action::pressed;
        add_event(ui::key_event{.code = *code, .action = action});
    }
}

auto input_collector::key_up(const window_message& message) -> void {
    drop_modifier(message.wparam);
    if (const std::optional<ui::key_code> code = key_code_of(message.wparam)) {
        add_event(ui::key_event{.code = *code, .action = ui::key_action::released});
    }
}

auto input_collector::type(u16 unit) -> void {
    if (is_high_surrogate(unit)) {
        m_high_surrogate = unit;
        return;
    }
    std::wstring units;
    if (is_low_surrogate(unit)) {
        if (!m_high_surrogate) {
            return;
        }
        units = {static_cast<wchar_t>(*m_high_surrogate), static_cast<wchar_t>(unit)};
    } else if (!is_control_unit(unit)) {
        units = {static_cast<wchar_t>(unit)};
    }
    m_high_surrogate.reset();
    if (!units.empty()) {
        add_event(ui::typed_text{.utf8 = to_utf8(units)});
    }
}

auto input_collector::tally(const window_message& message) -> void {
    switch (message.id) {
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
        if (!is_repeat(message)) {
            press_key(message.wparam);
        }
        return;
    case WM_KEYUP:
    case WM_SYSKEYUP:
        release_key(message.wparam);
        return;
    case WM_LBUTTONDOWN:
    case WM_LBUTTONDBLCLK:
        press_key(VK_LBUTTON);
        return;
    case WM_RBUTTONDOWN:
    case WM_RBUTTONDBLCLK:
        press_key(VK_RBUTTON);
        return;
    case WM_MBUTTONDOWN:
    case WM_MBUTTONDBLCLK:
        press_key(VK_MBUTTON);
        return;
    case WM_XBUTTONDOWN:
    case WM_XBUTTONDBLCLK:
        press_key(side_button_of(message));
        return;
    case WM_LBUTTONUP:
        release_key(VK_LBUTTON);
        return;
    case WM_RBUTTONUP:
        release_key(VK_RBUTTON);
        return;
    case WM_MBUTTONUP:
        release_key(VK_MBUTTON);
        return;
    case WM_XBUTTONUP:
        release_key(side_button_of(message));
        return;
    default:
        return;
    }
}

auto input_collector::press_key(u64 virtual_key) -> void {
    const usize code = virtual_key & 0xffU;
    m_feed.keys.is_down.at(code) = true;
    ++m_feed.keys.presses.at(code);
}

auto input_collector::release_key(u64 virtual_key) -> void {
    m_feed.keys.is_down.at(virtual_key & 0xffU) = false;
}

auto input_collector::lose_focus() -> void {
    // Nothing stays held for binds once the window can't see it let go.
    m_feed.keys.is_down = {};
    for (const mouse_button button :
        {mouse_button::left, mouse_button::right, mouse_button::middle}) {
        release(button);
    }
    m_feed.cursor.reset();
    m_held_modifiers = {};
    m_feed.modifiers = ui::no_modifiers;
    m_high_surrogate.reset();
}

auto input_collector::toggle_menu() -> void {
    m_feed.is_menu_open = !m_feed.is_menu_open;
    // The events of an earlier opening, and what the UI wanted then, are no part of this one.
    m_feed.events.clear();
    m_wanted = {};
    ++m_feed.serial;
    m_opened_at = m_feed.serial;
}

auto input_collector::hold_modifier(u64 virtual_key) -> void {
    if (const std::optional<usize> index = modifier_index(virtual_key)) {
        m_held_modifiers.at(*index) = true;
        m_feed.modifiers = held_flags(m_held_modifiers);
    }
}

auto input_collector::drop_modifier(u64 virtual_key) -> void {
    if (const std::optional<usize> index = modifier_index(virtual_key)) {
        m_held_modifiers.at(*index) = false;
        m_feed.modifiers = held_flags(m_held_modifiers);
    }
}

}
