#include <lucent/cs2-domains/command_domain.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <iterator>
#include <span>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/command_stages.hpp>
#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/cs2-domains/foreign/user_cmd.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/raw.hpp>
#include <lucent/kit/view_set.hpp>

// A command laid out in bytes as client.dll lays it out (the offsets are the 1.41.9.9 values), and
// the game's four calls stood in for by functions here that answer from and write into the same
// bytes. A step written into the wrong element, a count left stale, or a word or has-bit missed is
// a command that looks right locally and sends something else.

namespace lucent::cs2 {
namespace {

// The game's data, as a section of this test's own image no code lives in, so the method facts
// can point at this test's functions and pass resolve's checks.
constexpr u32 data_rva = 0x7000'0000;
constexpr isize data_size = 0x2000;

constexpr isize local_at = 0x10;
constexpr isize controller_at = 0x100;
constexpr isize command_at = 0x200;
constexpr isize base_at = 0x400;
constexpr isize buttons_at = 0x600;
constexpr isize rep_at = 0x700;
constexpr isize steps_at = 0x900;
constexpr isize step_stride = 0x40;
constexpr isize step_capacity = 8;

constexpr isize command_base = 0x40;
constexpr isize command_words = 0x60;
constexpr isize has_bits = 0x10;
constexpr isize base_buttons = 0x38;
constexpr isize base_steps = 0x18;
constexpr isize base_dx = 0x70;
constexpr isize base_dy = 0x74;
constexpr isize words_held = 0x18;
constexpr isize words_changed = 0x20;
constexpr isize step_button = 0x18;
constexpr isize step_pressed = 0x20;
constexpr isize step_when = 0x24;

constexpr u64 attack = u64{std::to_underlying(button::attack)};
constexpr u64 jump = u64{std::to_underlying(button::jump)};

// The bytes the stand-ins read and write, and where they appear.
struct game_bytes {
    std::array<std::byte, data_size> bytes{};
    u64 base = 0;
    isize steps_made = 0;
};

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the stand-ins for the game's functions are plain functions the domain calls, and reach the test's bytes no other way; each test sets it.
constinit game_bytes* game = nullptr;

auto offset_of(u64 address) -> isize {
    return static_cast<isize>(address - game->base);
}

// Bytes in and out of the laid-out game, any plain value.
constexpr auto put = [](isize offset, auto value) {
    const auto raw = std::bit_cast<std::array<std::byte, sizeof(value)>>(value);
    std::ranges::copy(raw, std::next(game->bytes.begin(), offset));
};

constexpr auto get = [](isize offset, auto kind) {
    std::array<std::byte, sizeof(kind)> raw{};
    std::ranges::copy_n(std::next(game->bytes.begin(), offset), std::ssize(raw), raw.begin());
    return std::bit_cast<decltype(kind)>(raw);
};

auto address_of(isize offset) -> u64 {
    return game->base + static_cast<u64>(offset);
}

// The game's four calls, as the facts declare them.
auto newest_sequence(foreign::player_controller* /*controller*/) -> i32 {
    return 7;
}

auto command_at_sequence(foreign::player_controller* /*controller*/, i32 sequence)
    -> foreign::user_cmd* {
    return sequence == 7 ? std::bit_cast<foreign::user_cmd*>(address_of(command_at)) : nullptr;
}

auto new_step(foreign::proto_arena* /*arena*/) -> foreign::subtick_step* {
    const isize made = steps_at + ((step_capacity - 1 - game->steps_made) * step_stride);
    ++game->steps_made;
    return std::bit_cast<foreign::subtick_step*>(address_of(made));
}

auto add_step(foreign::repeated_ptr_field* field, foreign::subtick_step* step)
    -> foreign::subtick_step* {
    const isize offset = offset_of(std::bit_cast<u64>(field));
    const i32 count = get(offset + 8, i32{});
    put(offset + 8, i32{count + 1});
    put(rep_at, i32{count + 1});
    put(rep_at + 8 + (isize{count} * 8), u64{std::bit_cast<u64>(step)});
    return step;
}

constexpr auto rva_of = [](auto* function, u64 image) {
    return std::bit_cast<u64>(function) - image;
};

// The facts behind the user command, resolved to the layout above and the stand-ins.
auto resolve_command(u64 image) -> void {
    const std::array values{
        kit::fact_value{
            .key = foreign::local_player_controller.record().key,
            .value = data_rva + local_at,
        },
        kit::fact_value{
            .key = foreign::controller_command_sequence.record().key,
            .value = rva_of(&newest_sequence, image),
        },
        kit::fact_value{
            .key = foreign::controller_user_command.record().key,
            .value = rva_of(&command_at_sequence, image),
        },
        kit::fact_value{
            .key = foreign::subtick_step_new.record().key,
            .value = rva_of(&new_step, image),
        },
        kit::fact_value{
            .key = foreign::repeated_add.record().key,
            .value = rva_of(&add_step, image),
        },
        kit::fact_value{.key = foreign::user_cmd_base.record().key, .value = command_base},
        kit::fact_value{.key = foreign::user_cmd_buttons.record().key, .value = command_words},
        kit::fact_value{.key = foreign::base_has_bits.record().key, .value = has_bits},
        kit::fact_value{.key = foreign::base_buttons.record().key, .value = base_buttons},
        kit::fact_value{.key = foreign::base_steps.record().key, .value = base_steps},
        kit::fact_value{.key = foreign::base_mouse_dx.record().key, .value = base_dx},
        kit::fact_value{.key = foreign::base_mouse_dy.record().key, .value = base_dy},
        kit::fact_value{.key = foreign::buttons_has_bits.record().key, .value = has_bits},
        kit::fact_value{.key = foreign::buttons_held.record().key, .value = words_held},
        kit::fact_value{.key = foreign::buttons_changed.record().key, .value = words_changed},
        kit::fact_value{.key = foreign::buttons_scroll.record().key, .value = 0x28},
        kit::fact_value{.key = foreign::step_rep_list.record().key, .value = 0},
        kit::fact_value{.key = foreign::step_has_bits.record().key, .value = has_bits},
        kit::fact_value{.key = foreign::step_button.record().key, .value = step_button},
        kit::fact_value{.key = foreign::step_pressed.record().key, .value = step_pressed},
        kit::fact_value{.key = foreign::step_when.record().key, .value = step_when},
        kit::fact_value{.key = foreign::step_forward.record().key, .value = 0x28},
        kit::fact_value{.key = foreign::step_left.record().key, .value = 0x2c},
        kit::fact_value{.key = foreign::step_pitch.record().key, .value = 0x30},
        kit::fact_value{.key = foreign::step_yaw.record().key, .value = 0x34},
    };
    kit::module_image own = *kit::image_at(client_module, image);
    own.sections.push_back(
        kit::image_section{
            .rva = data_rva,
            .size = static_cast<u32>(data_size),
            .is_executable = false,
            .is_writable = true,
        }
    );
    std::ignore = kit::resolve(kit::linked_fact_records(), values, std::array{own});
}

// One step of the game's own, as it is laid into a slot of the rep.
struct laid_step {
    u64 buttons = 0;
    edge change = edge::press;
    f32 when = 0.0F;
};

auto lay_step(isize slot, const laid_step& step) -> void {
    const isize offset = steps_at + (slot * step_stride);
    put(offset + has_bits, u32{0b111U});
    put(offset + step_button, step.buttons);
    put(offset + step_pressed, bool{step.change == edge::press});
    put(offset + step_when, step.when);
    put(rep_at + 8 + (slot * 8), address_of(offset));
}

// A command with no steps yet, the player holding the given buttons.
auto lay_command(u64 held) -> void {
    put(local_at, address_of(controller_at));
    put(command_at + command_base, address_of(base_at));
    put(command_at + command_words, held);
    put(base_at + base_buttons, address_of(buttons_at));
    put(base_at + base_steps + 0x10, address_of(rep_at));
    put(buttons_at + words_held, held);
}

auto lay_steps(i32 count) -> void {
    put(base_at + base_steps + 8, count);
    put(rep_at, count);
}

struct step_read {
    u64 buttons = 0;
    bool is_pressed = false;
    f32 when = 0.0F;
    u32 bits = 0;
};

auto step_in_command(isize index) -> step_read {
    const isize offset = offset_of(get(rep_at + 8 + (index * 8), u64{}));
    return {
        .buttons = get(offset + step_button, u64{}),
        .is_pressed = get(offset + step_pressed, bool{}),
        .when = get(offset + step_when, f32{}),
        .bits = get(offset + has_bits, u32{}),
    };
}

// One tick: open, hand the trigger stage to `asked`, apply with the counts owed.
auto run_tick(
    command_domain& domain, stdx::function_ref<void(const trigger_stage&)> asked, mouse_counts owed
) -> bool {
    mouse_model view;
    kit::view_set parts;
    domain.open();
    domain.put_parts(parts, view);
    const auto* const stage = parts.find<trigger_stage>();
    REQUIRE(stage != nullptr);
    asked(*stage);
    return domain.apply(owed);
}

class laid_out final {
public:
    laid_out() {
        m_bytes.base = std::bit_cast<u64>(GetModuleHandleW(nullptr)) + data_rva;
        game = &m_bytes;
        resolve_command(std::bit_cast<u64>(GetModuleHandleW(nullptr)));
    }

    laid_out(const laid_out&) = delete ("the stand-ins point offset it");
    auto operator=(const laid_out&) -> laid_out& = delete ("the stand-ins point offset it");
    laid_out(laid_out&&) = delete ("the stand-ins point offset it");
    auto operator=(laid_out&&) -> laid_out& = delete ("the stand-ins point offset it");

    ~laid_out() {
        game = nullptr;
    }

    auto source() -> lucent::foreign::memory_source {
        return lucent::foreign::memory_source::from_bytes(m_bytes.base, m_bytes.bytes);
    }

private:
    game_bytes m_bytes;
};

}

namespace {

// The game holding jump with its own press of it at half the tick, a stage pressing attack at
// the start.
auto press_attack_among_jump(command_domain& domain) -> bool {
    return run_tick(
        domain, [](const trigger_stage& stage) { stage.press(button::attack, 0.0F); }, {}
    );
}

auto lay_held_jump() -> void {
    lay_command(jump);
    lay_step(0, {.buttons = jump, .change = edge::press, .when = 0.5F});
    lay_steps(1);
}

}

TEST_CASE("a stage's press goes in among the game's steps, a new element made for it") {
    laid_out bytes;
    lay_held_jump();
    command_domain domain{kit::raw::token(), bytes.source()};

    const bool is_settled = press_attack_among_jump(domain);

    CHECK(is_settled);
    REQUIRE(get(base_at + base_steps + 8, i32{}) == 2);
    const step_read first = step_in_command(0);
    const step_read second = step_in_command(1);
    CHECK(first.buttons == attack);
    CHECK(first.is_pressed);
    CHECK(first.when == 0.0F);
    CHECK(first.bits == 0b111U);
    CHECK(second.buttons == jump);
    CHECK(second.when == 0.5F);
}

TEST_CASE("a stage's press is in both copies of the words, marked present") {
    laid_out bytes;
    lay_held_jump();
    command_domain domain{kit::raw::token(), bytes.source()};

    std::ignore = press_attack_among_jump(domain);

    // The command's own words and the base command's.
    CHECK(get(command_at + command_words, u64{}) == (attack | jump));
    CHECK(get(command_at + command_words + 8, u64{}) == attack);
    CHECK(get(buttons_at + words_held, u64{}) == (attack | jump));
    CHECK(get(buttons_at + words_changed, u64{}) == attack);
    CHECK(get(buttons_at + has_bits, u32{}) == 0b11U);
    CHECK((get(base_at + has_bits, u32{}) & 0b10U) != 0);
}

TEST_CASE("the game's steps for a taken button go, and the elements left over are cleared") {
    laid_out bytes;
    lay_command(attack);
    lay_step(0, {.buttons = attack, .change = edge::press, .when = 0.25F});
    lay_step(1, {.buttons = attack, .change = edge::release, .when = 0.5F});
    lay_steps(2);
    command_domain domain{kit::raw::token(), bytes.source()};

    std::ignore = run_tick(
        domain, [](const trigger_stage& stage) { stage.release(button::attack, 0.0F); }, {}
    );

    REQUIRE(get(base_at + base_steps + 8, i32{}) == 1);
    CHECK(step_in_command(0).buttons == attack);
    CHECK_FALSE(step_in_command(0).is_pressed);
    // The second element stays constructed for the next Add, with nothing of ours in it.
    CHECK(get(rep_at, i32{}) == 2);
    CHECK(step_in_command(1).bits == 0U);
    CHECK(get(command_at + command_words, u64{}) == 0U);
}

TEST_CASE("owed counts are added to the player's own, each axis marked once it moved") {
    laid_out bytes;
    lay_command(0);
    lay_steps(0);
    put(base_at + base_dx, i32{5});
    command_domain domain{kit::raw::token(), bytes.source()};

    const bool is_settled =
        run_tick(domain, [](const trigger_stage& /*stage*/) {}, {.dx = 3, .dy = 0});

    CHECK(is_settled);
    CHECK(get(base_at + base_dx, i32{}) == 8);
    CHECK(get(base_at + base_dy, i32{}) == 0);
    CHECK(get(base_at + has_bits, u32{}) == 0x1000U);
}

TEST_CASE("a refused tick writes no step and says why on the next") {
    laid_out bytes;
    lay_command(jump);
    lay_step(0, {.buttons = jump, .change = edge::release, .when = 0.5F});
    lay_steps(1);
    command_domain domain{kit::raw::token(), bytes.source()};

    std::ignore =
        run_tick(domain, [](const trigger_stage& stage) { stage.press(button::attack, 0.5F); }, {});

    CHECK(get(base_at + base_steps + 8, i32{}) == 1);
    CHECK(step_in_command(0).buttons == jump);
    kit::view_set parts;
    mouse_model view;
    domain.open();
    domain.put_parts(parts, view);
    const auto* const input = parts.find<command_input>();
    REQUIRE(input != nullptr);
    REQUIRE(input->refusals.size() == 1);
    CHECK(input->refusals.front().reason == refusal_reason::press_meets_release);
}

}
