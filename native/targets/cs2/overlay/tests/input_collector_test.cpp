#include <lucent/cs2-overlay/input_collector.hpp>

#include <array>
#include <bit>
#include <chrono>
#include <limits>
#include <optional>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/input_snapshot.hpp>

// In the game a wrong translation shows as a menu that misses clicks or keys, and a wrong
// blocking decision as a game that walks while the member types, or a menu the game steals input
// from. Neither is visible from code, and the game can't be run in a test.

namespace lucent::cs2::overlay {
namespace {

constexpr click_rules rules{
    .interval = std::chrono::milliseconds{500},
    .area = {.x = 4.0F, .y = 4.0F},
};
constexpr draw::vec2 client{.x = 1600.0F, .y = 900.0F};

auto packed(i32 x, i32 y) -> i64 {
    const u32 low = static_cast<u16>(std::bit_cast<u32>(x) & 0xffffU);
    const u32 high = static_cast<u16>(std::bit_cast<u32>(y) & 0xffffU);
    return i64{(high << 16U) | low};
}

auto mouse(u32 id, i32 x, i32 y) -> window_message {
    return {.id = id, .wparam = 0, .lparam = packed(x, y), .time = 0};
}

// The message as GetMessageTime() would have it at time.
auto stamped(window_message message, u32 time) -> window_message {
    message.time = time;
    return message;
}

auto key(u32 id, u64 virtual_key) -> window_message {
    return {.id = id, .wparam = virtual_key, .lparam = 0, .time = 0};
}

// A key-down the keyboard repeats: bit 30 says the key was already down.
auto repeat(u64 virtual_key) -> window_message {
    return {
        .id = WM_KEYDOWN,
        .wparam = virtual_key,
        .lparam = std::bit_cast<i64>(u64{1} << 30U),
        .time = 0,
    };
}

auto character(u16 unit) -> window_message {
    return {.id = WM_CHAR, .wparam = unit, .lparam = 0, .time = 0};
}

auto wheel(i16 delta) -> window_message {
    const u64 high = std::bit_cast<u16>(delta);
    return {.id = WM_MOUSEWHEEL, .wparam = high << 16U, .lparam = 0, .time = 0};
}

// Compared as an array, so a check shows both; NaN when absent.
auto coordinates(std::optional<draw::vec2> point) -> std::array<f32, 2> {
    if (!point) {
        const f32 none = std::numeric_limits<f32>::quiet_NaN();
        return {none, none};
    }
    return {point->x, point->y};
}

auto open_menu(input_collector& collector) -> void {
    collector.record(key(WM_KEYDOWN, VK_INSERT));
    collector.record(key(WM_KEYUP, VK_INSERT));
}

// The snapshot the presenting thread would build now, after all it consumed before.
auto frame_of(const input_collector& collector, u64 consumed) -> frame_snapshot {
    return snapshot_of(
        collector.feed(), consumed, {.time = {}, .client_size = client, .viewport = client}
    );
}

enum class wanted : u8 { nothing, mouse, keyboard, both };

// A report on a frame that took everything recorded so far.
auto wanting(const input_collector& collector, wanted devices) -> menu_report {
    return {
        .consumed = collector.feed().serial,
        .wants_mouse = devices == wanted::mouse || devices == wanted::both,
        .wants_keyboard = devices == wanted::keyboard || devices == wanted::both,
    };
}

TEST_CASE(
    "the menu key opens and closes the menu, ignores its repeat, and never reaches the game"
) {
    input_collector collector{rules};

    CHECK(kind_of(key(WM_KEYDOWN, VK_INSERT)) == message_kind::menu_key);
    CHECK(kind_of(key(WM_KEYUP, VK_INSERT)) == message_kind::menu_key);
    collector.record(key(WM_KEYDOWN, VK_INSERT));
    CHECK(collector.feed().is_menu_open);
    collector.record(repeat(VK_INSERT));
    CHECK(collector.feed().is_menu_open);
    collector.record(key(WM_KEYUP, VK_INSERT));
    CHECK(collector.should_keep_from_game(message_kind::menu_key));
    collector.record(key(WM_KEYDOWN, VK_INSERT));
    CHECK_FALSE(collector.feed().is_menu_open);
}

TEST_CASE("a click becomes a press with its count and a release, at the cursor") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(mouse(WM_MOUSEMOVE, 100, 200));
    collector.record(stamped(mouse(WM_LBUTTONDOWN, 100, 200), 1000));
    const frame_snapshot pressed = frame_of(collector, 0);
    collector.record(stamped(mouse(WM_LBUTTONUP, 100, 200), 1050));
    const frame_snapshot released = frame_of(collector, pressed.consumed);

    CHECK(coordinates(pressed.input.cursor) == std::array{100.0F, 200.0F});
    CHECK(pressed.input.left.is_down);
    CHECK(pressed.input.left.click_count == 1);
    CHECK_FALSE(released.input.left.is_down);
    CHECK(released.input.left.click_count == 0);
    CHECK(released.input.left.is_released);
}

TEST_CASE("a second press soon enough and close enough counts two; a late or far one starts over") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(stamped(mouse(WM_LBUTTONDOWN, 100, 100), 1000));
    collector.record(stamped(mouse(WM_LBUTTONUP, 100, 100), 1050));
    u64 consumed = frame_of(collector, 0).consumed;

    collector.record(stamped(mouse(WM_LBUTTONDOWN, 101, 101), 1200));
    CHECK(frame_of(collector, consumed).input.left.click_count == 2);
    consumed = frame_of(collector, consumed).consumed;
    collector.record(stamped(mouse(WM_LBUTTONUP, 101, 101), 1250));

    collector.record(stamped(mouse(WM_LBUTTONDOWN, 101, 101), 1900));
    CHECK(frame_of(collector, consumed).input.left.click_count == 1);
    consumed = frame_of(collector, consumed).consumed;
    collector.record(stamped(mouse(WM_LBUTTONUP, 101, 101), 1950));

    collector.record(stamped(mouse(WM_LBUTTONDOWN, 140, 101), 2000));
    CHECK(frame_of(collector, consumed).input.left.click_count == 1);
}

TEST_CASE("a press and release within one frame both reach its snapshot") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(stamped(mouse(WM_LBUTTONDOWN, 10, 10), 1000));
    collector.record(stamped(mouse(WM_LBUTTONUP, 10, 10), 1010));
    const ui::input_snapshot input = frame_of(collector, 0).input;

    CHECK(input.left.click_count == 1);
    CHECK(input.left.is_released);
    CHECK_FALSE(input.left.is_down);
}

TEST_CASE("the cursor is scaled from client pixels to the viewport, and absent outside it") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(mouse(WM_MOUSEMOVE, 800, 450));
    const frame_place half{
        .time = {},
        .client_size = client,
        .viewport = {.x = 800.0F, .y = 450.0F},
    };
    CHECK(
        coordinates(snapshot_of(collector.feed(), 0, half).input.cursor)
        == std::array{400.0F, 225.0F}
    );

    collector.record(mouse(WM_MOUSEMOVE, -5, 20));
    CHECK_FALSE(snapshot_of(collector.feed(), 0, half).input.cursor.has_value());
}

TEST_CASE("wheel notches add up over a frame, positive away from the user") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(wheel(WHEEL_DELTA));
    collector.record(wheel(WHEEL_DELTA));
    collector.record(wheel(-WHEEL_DELTA / 2));

    CHECK(coordinates(frame_of(collector, 0).input.wheel) == std::array{0.0F, 1.5F});
}

TEST_CASE("keys come pressed, repeated and released, in order; unmapped keys add nothing") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(key(WM_KEYDOWN, VK_LEFT));
    collector.record(repeat(VK_LEFT));
    collector.record(key(WM_KEYDOWN, 'W'));
    collector.record(key(WM_KEYUP, VK_LEFT));

    CHECK(
        frame_of(collector, 0).input.keys
        == std::vector<ui::key_event>{
            {.code = ui::key_code::left, .action = ui::key_action::pressed},
            {.code = ui::key_code::left, .action = ui::key_action::repeated},
            {.code = ui::key_code::left, .action = ui::key_action::released},
        }
    );
}

TEST_CASE("characters become UTF-8, surrogate pairs joined and control characters dropped") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(character(u'a'));
    collector.record(character(0x00e9U));
    collector.record(character(0xd83dU));
    collector.record(character(0xde00U));
    collector.record(character(0x08U));
    collector.record(character(0xde00U));

    CHECK(frame_of(collector, 0).input.text == "a\xC3\xA9\xF0\x9F\x98\x80");
}

TEST_CASE("shift, control and alt are held between their down and up") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(key(WM_KEYDOWN, VK_SHIFT));
    collector.record(key(WM_SYSKEYDOWN, VK_MENU));
    CHECK(frame_of(collector, 0).input.modifiers == flags{ui::modifier::shift, ui::modifier::alt});

    collector.record(key(WM_KEYUP, VK_SHIFT));
    collector.record(key(WM_SYSKEYUP, VK_MENU));
    CHECK(frame_of(collector, 0).input.modifiers == ui::no_modifiers);
}

TEST_CASE("a frame takes only events after the last one it consumed") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(character(u'a'));
    const frame_snapshot first = frame_of(collector, 0);
    collector.record(character(u'b'));

    CHECK(frame_of(collector, first.consumed).input.text == "b");
    collector.acknowledge(wanting(collector, wanted::nothing));
    CHECK(collector.feed().events.empty());
}

TEST_CASE("nothing is recorded as an event while the menu is closed, and opening drops the old") {
    input_collector collector{rules};
    collector.record(character(u'a'));
    collector.record(stamped(mouse(WM_LBUTTONDOWN, 10, 10), 1000));
    CHECK(collector.feed().events.empty());
    CHECK(collector.feed().buttons.at(0));

    open_menu(collector);
    collector.record(character(u'b'));
    open_menu(collector);
    open_menu(collector);
    CHECK(collector.feed().events.empty());
}

TEST_CASE("input is kept from the game only while the menu is open and the UI wants that device") {
    input_collector collector{rules};
    collector.acknowledge(wanting(collector, wanted::both));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::mouse));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::keyboard));

    open_menu(collector);
    CHECK_FALSE(collector.should_keep_from_game(message_kind::mouse));
    collector.acknowledge(wanting(collector, wanted::mouse));
    CHECK(collector.should_keep_from_game(message_kind::mouse));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::keyboard));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::other));

    collector.acknowledge(wanting(collector, wanted::keyboard));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::mouse));
    CHECK(collector.should_keep_from_game(message_kind::keyboard));

    open_menu(collector);
    CHECK_FALSE(collector.should_keep_from_game(message_kind::keyboard));
}

TEST_CASE("a report from a frame before this opening of the menu decides nothing") {
    input_collector collector{rules};
    open_menu(collector);
    const menu_report stale = wanting(collector, wanted::both);
    open_menu(collector);
    open_menu(collector);

    collector.acknowledge(stale);
    CHECK_FALSE(collector.should_keep_from_game(message_kind::mouse));
    CHECK_FALSE(collector.should_keep_from_game(message_kind::keyboard));
}

TEST_CASE("releases and system keys reach the game even when the menu wants both devices") {
    input_collector collector{rules};
    open_menu(collector);
    collector.acknowledge(wanting(collector, wanted::both));

    CHECK(collector.should_keep_from_game(kind_of(mouse(WM_LBUTTONDOWN, 1, 1))));
    CHECK(collector.should_keep_from_game(kind_of(key(WM_KEYDOWN, 'W'))));
    CHECK(collector.should_keep_from_game(kind_of(character(u'w'))));
    CHECK_FALSE(collector.should_keep_from_game(kind_of(mouse(WM_LBUTTONUP, 1, 1))));
    CHECK_FALSE(collector.should_keep_from_game(kind_of(key(WM_KEYUP, 'W'))));
    CHECK_FALSE(collector.should_keep_from_game(kind_of(key(WM_SYSKEYDOWN, VK_F4))));
}

TEST_CASE("losing focus releases held buttons, clears modifiers and forgets the cursor") {
    input_collector collector{rules};
    open_menu(collector);
    collector.record(stamped(mouse(WM_LBUTTONDOWN, 10, 10), 1000));
    collector.record(key(WM_KEYDOWN, VK_CONTROL));
    const u64 consumed = frame_of(collector, 0).consumed;

    collector.record({.id = WM_ACTIVATEAPP, .wparam = 0, .lparam = 0, .time = 0});
    const ui::input_snapshot input = frame_of(collector, consumed).input;
    CHECK(input.left.is_released);
    CHECK_FALSE(input.left.is_down);
    CHECK(input.modifiers == ui::no_modifiers);
    CHECK_FALSE(input.cursor.has_value());
}

auto side_button(u32 id, u16 button) -> window_message {
    return {.id = id, .wparam = u64{button} << 16U, .lparam = 0, .time = 0};
}

TEST_CASE("binds see every key and mouse button, with the menu closed or open") {
    input_collector collector{rules};
    collector.record(key(WM_KEYDOWN, 'F'));
    collector.record(repeat('F'));
    collector.record(side_button(WM_XBUTTONDOWN, XBUTTON2));
    collector.record(mouse(WM_RBUTTONDOWN, 1, 1));
    collector.record(mouse(WM_RBUTTONUP, 1, 1));
    collector.record(key(WM_SYSKEYDOWN, VK_MENU));
    open_menu(collector);
    collector.record(mouse(WM_LBUTTONDOWN, 1, 1));

    const key_tally& keys = collector.feed().keys;
    // A repeat is no press.
    CHECK(keys.presses.at('F') == 1);
    CHECK(keys.is_down.at('F'));
    CHECK(keys.is_down.at(VK_XBUTTON2));
    CHECK_FALSE(keys.is_down.at(VK_XBUTTON1));
    CHECK(keys.presses.at(VK_RBUTTON) == 1);
    CHECK_FALSE(keys.is_down.at(VK_RBUTTON));
    CHECK(keys.is_down.at(VK_MENU));
    CHECK(keys.is_down.at(VK_LBUTTON));
    CHECK(keys.presses.at(VK_INSERT) == 1);
}

TEST_CASE("losing focus lets go of every key binds see, and keeps their press counts") {
    input_collector collector{rules};
    collector.record(key(WM_KEYDOWN, 'F'));
    collector.record(side_button(WM_XBUTTONDOWN, XBUTTON1));

    collector.record({.id = WM_KILLFOCUS, .wparam = 0, .lparam = 0, .time = 0});
    const key_tally& keys = collector.feed().keys;
    CHECK_FALSE(keys.is_down.at('F'));
    CHECK_FALSE(keys.is_down.at(VK_XBUTTON1));
    CHECK(keys.presses.at('F') == 1);
}

}
}
