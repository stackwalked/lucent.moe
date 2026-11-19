#include <lucent/cs2-domains/command_domain.hpp>

#include <optional>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/fault.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_board.hpp>
#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/cs2-domains/foreign/user_cmd.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/read_access.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/kit/write_access.hpp>

namespace lucent::cs2 {

namespace {

using reader = kit::read_access<foreign::user_command>;
using writer = kit::write_access<foreign::user_command>;
using step_ptr = lucent::foreign::foreign_ptr<foreign::subtick_step>;
using base_ptr = lucent::foreign::foreign_ptr<foreign::base_user_cmd>;
using command_ptr = lucent::foreign::foreign_ptr<foreign::user_cmd>;
using buttons_ptr = lucent::foreign::foreign_ptr<foreign::button_state_pb>;
using controller_ptr = lucent::foreign::foreign_ptr<foreign::player_controller>;
using field_ptr = lucent::foreign::foreign_ptr<foreign::repeated_ptr_field>;

// The has-bits of each message's fields, numbered by declaration order as protobuf numbers
// them. build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44) found: each serializer tests the
// bit before writing the field's tag (CSubtickMoveStep client+0x4f2d90, CInButtonStatePB
// +0x4f26a0, CBaseUserCmdPB +0x4f4540); every field's finder matches the test of exactly this
// bit beside the field's load and tag, so a renumbering fails the finder rather than this
// breaks: fields written but not sent, or sent that weren't written
constexpr u32 step_has_button = 1U << 0U;
constexpr u32 step_has_pressed = 1U << 1U;
constexpr u32 step_has_when = 1U << 2U;
constexpr u32 step_has_forward = 1U << 3U;
constexpr u32 step_has_left = 1U << 4U;
constexpr u32 step_has_pitch = 1U << 5U;
constexpr u32 step_has_yaw = 1U << 6U;
constexpr u32 buttons_has_held = 1U << 0U;
constexpr u32 buttons_has_changed = 1U << 1U;
constexpr u32 base_has_buttons = 1U << 1U;
constexpr u32 base_has_mouse_dx = 1U << 12U;
constexpr u32 base_has_mouse_dy = 1U << 13U;

// The command open this tick, as the game left it.
struct open_command {
    command_ptr command;
    base_ptr base;
    buttons_ptr buttons;
    foreign::repeated_ptr_field steps;
    foreign::step_list list;
    game_command game;
};

auto read_step(const reader& game, step_ptr step) -> result<subtick_step> {
    const u32 bits = LUCENT_TRY(game.read<foreign::step_has_bits>(step));
    // A field the step's has-bits don't mark is absent, whatever its bytes hold.
    const auto present = [bits](u32 bit, auto value) {
        return (bits & bit) != 0 ? std::optional{value} : std::nullopt;
    };
    return subtick_step{
        .when = LUCENT_TRY(game.read<foreign::step_when>(step)),
        .buttons = present(step_has_button, LUCENT_TRY(game.read<foreign::step_button>(step))),
        .is_pressed = present(step_has_pressed, LUCENT_TRY(game.read<foreign::step_pressed>(step))),
        .forward = present(step_has_forward, LUCENT_TRY(game.read<foreign::step_forward>(step))),
        .left = present(step_has_left, LUCENT_TRY(game.read<foreign::step_left>(step))),
        .pitch = present(step_has_pitch, LUCENT_TRY(game.read<foreign::step_pitch>(step))),
        .yaw = present(step_has_yaw, LUCENT_TRY(game.read<foreign::step_yaw>(step))),
    };
}

// Every field written, absent ones as protobuf's cleared defaults, and the has-bits last.
auto write_step(const writer& game, step_ptr step, const subtick_step& written) -> result<void> {
    const auto bit_of = [](const auto& field, u32 bit) { return field.has_value() ? bit : 0U; };
    const u32 bits = step_has_when
                     | bit_of(written.buttons, step_has_button)
                     | bit_of(written.is_pressed, step_has_pressed)
                     | bit_of(written.forward, step_has_forward)
                     | bit_of(written.left, step_has_left)
                     | bit_of(written.pitch, step_has_pitch)
                     | bit_of(written.yaw, step_has_yaw);
    LUCENT_TRY(game.write<foreign::step_button>(step, written.buttons.value_or(0)));
    LUCENT_TRY(game.write<foreign::step_pressed>(step, written.is_pressed.value_or(false)));
    LUCENT_TRY(game.write<foreign::step_when>(step, written.when));
    LUCENT_TRY(game.write<foreign::step_forward>(step, written.forward.value_or(0.0F)));
    LUCENT_TRY(game.write<foreign::step_left>(step, written.left.value_or(0.0F)));
    LUCENT_TRY(game.write<foreign::step_pitch>(step, written.pitch.value_or(0.0F)));
    LUCENT_TRY(game.write<foreign::step_yaw>(step, written.yaw.value_or(0.0F)));
    return game.write<foreign::step_has_bits>(step, bits);
}

// A step past the live count, cleared the way protobuf's Clear leaves it, so the next Add that
// takes it back finds nothing of ours.
auto clear_step(const writer& game, step_ptr step) -> result<void> {
    LUCENT_TRY(write_step(game, step, subtick_step{}));
    return game.write<foreign::step_has_bits>(step, 0U);
}

auto read_list(const reader& game, const foreign::repeated_ptr_field& steps)
    -> result<foreign::step_list> {
    if (lucent::foreign::is_null(steps.rep)) {
        LUCENT_ENSURE(steps.size == 0);
        return foreign::step_list{};
    }
    const foreign::step_list list = LUCENT_TRY(game.read<foreign::step_rep_list>(steps.rep));
    LUCENT_ENSURE(list.allocated >= steps.size && list.allocated <= foreign::step_slots);
    return list;
}

auto read_command(const reader& game, const writer& calls) -> result<std::optional<open_command>> {
    const controller_ptr controller = LUCENT_TRY(game.read<foreign::local_player_controller>());
    if (lucent::foreign::is_null(controller)) {
        return std::nullopt;
    }
    const i32 sequence = calls.call<foreign::controller_command_sequence>(controller);
    const command_ptr command = calls.call<foreign::controller_user_command>(controller, sequence);
    if (lucent::foreign::is_null(command)) {
        return std::nullopt;
    }
    open_command opened{};
    opened.command = command;
    opened.base = LUCENT_TRY(game.read<foreign::user_cmd_base>(command));
    opened.buttons = LUCENT_TRY(game.read<foreign::base_buttons>(opened.base));
    if (lucent::foreign::is_null(opened.buttons)) {
        // The builder makes the button state with every command; none is a command it didn't
        // finish, which nothing writes into.
        return std::nullopt;
    }
    const foreign::button_words words = LUCENT_TRY(game.read<foreign::user_cmd_buttons>(command));
    opened.game.buttons = {.held = words[0], .changed = words[1], .scroll = words[2]};
    opened.steps = LUCENT_TRY(game.read<foreign::base_steps>(opened.base));
    LUCENT_ENSURE(opened.steps.size >= 0 && opened.steps.size <= foreign::step_slots);
    opened.list = LUCENT_TRY(read_list(game, opened.steps));
    for (isize index = 0; index < opened.steps.size; ++index) {
        opened.game.steps.push_back(
            LUCENT_TRY(read_step(game, opened.list.elements.at(narrow<usize>(index))))
        );
    }
    return opened;
}

// The elements the list has already constructed: the plan's steps overwrite them, and the ones
// the plan no longer uses, up to the old live count, are cleared.
auto rewrite_elements(
    const writer& written,
    const foreign::step_list& list,
    isize live,
    std::span<const subtick_step> steps
) -> result<void> {
    const isize wanted = std::ssize(steps);
    for (const auto [index, step] :
        std::views::enumerate(steps | std::views::take(list.allocated))) {
        LUCENT_TRY(write_step(written, list.elements.at(narrow<usize>(index)), step));
    }
    for (isize index = wanted; index < live; ++index) {
        LUCENT_TRY(clear_step(written, list.elements.at(narrow<usize>(index))));
    }
    return {};
}

// The steps past the constructed elements, made in the command's arena the way protobuf's Add
// makes them.
auto add_elements(
    const reader& game,
    const writer& written,
    base_ptr base,
    const foreign::step_list& list,
    std::span<const subtick_step> steps
) -> result<void> {
    foreign::repeated_ptr_field field = LUCENT_TRY(game.read<foreign::base_steps>(base));
    // Every constructed element is live now, so Add appends.
    field.size = list.allocated;
    LUCENT_TRY(written.write<foreign::base_steps>(base, field));
    const field_ptr place = game.field_ptr<foreign::base_steps>(base);
    for (const subtick_step& step : steps | std::views::drop(list.allocated)) {
        const step_ptr made = written.call<foreign::subtick_step_new>(field.arena);
        LUCENT_ENSURE(!lucent::foreign::is_null(made));
        const step_ptr added = written.call<foreign::repeated_add>(place, made);
        LUCENT_TRY(write_step(written, added, step));
    }
    return {};
}

// The plan's steps into the command's list: the elements it has first, then new ones; what the
// plan no longer uses is cleared.
auto write_steps(
    const reader& game, const writer& written, base_ptr base, std::span<const subtick_step> steps
) -> result<void> {
    const foreign::repeated_ptr_field before = LUCENT_TRY(game.read<foreign::base_steps>(base));
    const foreign::step_list list = LUCENT_TRY(read_list(game, before));
    const isize wanted = std::ssize(steps);
    LUCENT_TRY(rewrite_elements(written, list, before.size, steps));
    if (wanted > list.allocated) {
        LUCENT_TRY(add_elements(game, written, base, list, steps));
    }
    foreign::repeated_ptr_field after = LUCENT_TRY(game.read<foreign::base_steps>(base));
    after.size = static_cast<i32>(wanted);
    return written.write<foreign::base_steps>(base, after);
}

// Both copies of the words: the command's own, which the client's movement reads, and the base
// command's, which serializes.
auto write_buttons(
    const reader& game,
    const writer& written,
    command_ptr command,
    const open_command& opened,
    button_state words
) -> result<void> {
    LUCENT_TRY(written.write<foreign::user_cmd_buttons>(
        command, foreign::button_words{words.held, words.changed, words.scroll}
    ));
    LUCENT_TRY(written.write<foreign::buttons_held>(opened.buttons, words.held));
    LUCENT_TRY(written.write<foreign::buttons_changed>(opened.buttons, words.changed));
    const u32 buttons_bits = LUCENT_TRY(game.read<foreign::buttons_has_bits>(opened.buttons));
    LUCENT_TRY(written.write<foreign::buttons_has_bits>(
        opened.buttons, buttons_bits | buttons_has_held | buttons_has_changed
    ));
    const u32 base_bits = LUCENT_TRY(game.read<foreign::base_has_bits>(opened.base));
    return written.write<foreign::base_has_bits>(opened.base, base_bits | base_has_buttons);
}

// Added to the counts the player's own mouse put there; an axis carries its bit once it moved.
auto write_counts(const reader& game, const writer& written, base_ptr base, mouse_counts owed)
    -> result<void> {
    u32 bits = LUCENT_TRY(game.read<foreign::base_has_bits>(base));
    if (owed.dx != 0) {
        const i32 player_x = LUCENT_TRY(game.read<foreign::base_mouse_dx>(base));
        LUCENT_TRY(written.write<foreign::base_mouse_dx>(base, player_x + owed.dx));
        bits |= base_has_mouse_dx;
    }
    if (owed.dy != 0) {
        const i32 player_y = LUCENT_TRY(game.read<foreign::base_mouse_dy>(base));
        LUCENT_TRY(written.write<foreign::base_mouse_dy>(base, player_y + owed.dy));
        bits |= base_has_mouse_dy;
    }
    return written.write<foreign::base_has_bits>(base, bits);
}

}

command_domain::command_domain(const kit::domain_token& opens, lucent::foreign::memory_source game)
    : m_game{game}
    , m_opens{opens} {}

auto command_domain::open() -> void {
    m_input.reset();
    m_board.clear();
    if (!kit::is_available(foreign::user_command{})) {
        return;
    }
    const reader game{m_opens, m_game};
    const writer calls{m_opens, m_game};
    const result<std::optional<open_command>> opened = read_command(game, calls);
    if (!opened || !*opened) {
        return;
    }
    ++m_tick;
    m_input = command_input{
        .tick = m_tick,
        .game = (*opened)->game,
        .refusals = std::exchange(m_refusals, {}),
    };
}

auto command_domain::put_parts(kit::view_set& parts, mouse_model& view) -> void {
    if (!m_input) {
        return;
    }
    m_movement.emplace(m_board);
    m_aim_view.emplace(view);
    m_aim_shot.emplace(m_board);
    m_trigger.emplace(m_board);
    m_scripts.emplace(m_board);
    parts.put(*m_input);
    parts.put(*m_movement);
    parts.put(*m_aim_view);
    parts.put(*m_aim_shot);
    parts.put(*m_trigger);
    parts.put(*m_scripts);
}

auto command_domain::apply(mouse_counts owed) -> bool {
    if (!m_input) {
        return false;
    }
    const reader game{m_opens, m_game};
    const writer written{m_opens, m_game};
    // Read again: a feature's tick may have run the game's code in between.
    const result<std::optional<open_command>> reopened = read_command(game, written);
    m_input.reset();
    if (!reopened || !*reopened) {
        return false;
    }
    const open_command& opened = **reopened;
    if (!m_board.requests().empty()) {
        planned outcome = plan_command(opened.game, m_board.requests());
        m_refusals = std::move(outcome.refusals);
        if (outcome.plan) {
            const result<void> wrote = write_steps(game, written, opened.base, outcome.plan->steps);
            if (wrote) {
                std::ignore =
                    write_buttons(game, written, opened.command, opened, outcome.plan->buttons);
            }
        }
    }
    m_board.clear();
    if (owed == mouse_counts{}) {
        return true;
    }
    return write_counts(game, written, opened.base, owed).has_value();
}

auto command_domain::tick() const -> i64 {
    return m_tick;
}
}
