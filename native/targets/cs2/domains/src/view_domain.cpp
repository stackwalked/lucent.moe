#include <lucent/cs2-domains/view_domain.hpp>

#include <bit>
#include <cmath>
#include <optional>
#include <tuple>

#include <lucent/core/fault.hpp>
#include <lucent/cs2-domains/foreign/input.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>
#include <lucent/cs2-domains/view_state.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/read_access.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/kit/write_access.hpp>

namespace lucent::cs2 {
namespace {

using reader = kit::read_access<foreign::view_angles>;
using writer = kit::write_access<foreign::view_angles>;
using input_ptr = lucent::foreign::foreign_ptr<foreign::ccsgo_input>;
using sample_ptr = lucent::foreign::foreign_ptr<foreign::input_sample>;

// Split-screen slot 0, the only one the input's getter and setter serve.
constexpr i32 first_slot = 0;
// Far more input samples than a frame gathers; past it the count is torn.
constexpr i32 max_samples = 1024;
// Far more than any sensitivity turns by in one count.
constexpr f32 max_count_size = 10.0F;

// Where the view angles are now: the last pending sample's while there are any, else the
// resting angles, as the game's getter and setter choose.
auto angles_place(const reader& game, input_ptr input) -> result<std::optional<sample_ptr>> {
    const i32 count = LUCENT_TRY(game.read<foreign::input_sample_count>(input));
    LUCENT_ENSURE(count >= 0 && count <= max_samples);
    if (count == 0) {
        return std::nullopt;
    }
    const sample_ptr first = LUCENT_TRY(game.read<foreign::input_samples>(input));
    return game.element<foreign::input_sample_size>(first, isize{count - 1});
}

auto read_heading(const reader& game, input_ptr input) -> result<heading> {
    const std::optional<sample_ptr> sample = LUCENT_TRY(angles_place(game, input));
    const foreign::angles held = sample
                                     ? LUCENT_TRY(game.read<foreign::input_sample_angles>(*sample))
                                     : LUCENT_TRY(game.read<foreign::input_view_angles>(input));
    LUCENT_ENSURE(std::isfinite(held.pitch) && std::isfinite(held.yaw));
    return heading{.pitch = held.pitch, .yaw = held.yaw};
}

// Keeps the roll the game holds.
auto write_heading(const reader& game, const writer& written, input_ptr input, heading turned)
    -> result<void> {
    const std::optional<sample_ptr> sample = LUCENT_TRY(angles_place(game, input));
    if (sample) {
        foreign::angles held = LUCENT_TRY(game.read<foreign::input_sample_angles>(*sample));
        held.pitch = turned.pitch;
        held.yaw = turned.yaw;
        return written.write<foreign::input_sample_angles>(*sample, held);
    }
    foreign::angles held = LUCENT_TRY(game.read<foreign::input_view_angles>(input));
    held.pitch = turned.pitch;
    held.yaw = turned.yaw;
    return written.write<foreign::input_view_angles>(input, held);
}

// What one count turns the view by, from the game's own conversion of one count on each axis at
// no zoom. Its outs are our own locals, which the game's code writes.
auto count_size_of(const writer& game) -> std::optional<count_size> {
    // NOLINTBEGIN(misc-const-correctness): the game's code writes these through the pointers it is given.
    f32 pitch = 0.0F;
    f32 yaw = 0.0F;
    i32 scaled_x = 0;
    i32 scaled_y = 0;
    // NOLINTEND(misc-const-correctness)
    std::ignore = game.call<foreign::mouse_turn>(
        first_slot,
        1.0F,
        1.0F,
        1.0F,
        lucent::foreign::foreign_ptr<f32>{.address = std::bit_cast<u64>(&pitch)},
        lucent::foreign::foreign_ptr<f32>{.address = std::bit_cast<u64>(&yaw)},
        lucent::foreign::foreign_ptr<i32>{.address = std::bit_cast<u64>(&scaled_x)},
        lucent::foreign::foreign_ptr<i32>{.address = std::bit_cast<u64>(&scaled_y)}
    );
    const auto is_count = [](f32 size) {
        return std::isfinite(size) && size != 0.0F && std::abs(size) < max_count_size;
    };
    if (!is_count(pitch) || !is_count(yaw)) {
        return std::nullopt;
    }
    return count_size{.pitch = pitch, .yaw = yaw};
}

}

view_domain::view_domain(const kit::domain_token& opens, lucent::foreign::memory_source game)
    : m_game{game}
    , m_opens{opens} {}

auto view_domain::put_parts(kit::view_set& parts, i64 tick) -> void {
    m_state.reset();
    m_turns.reset();
    if (!kit::is_available(foreign::view_angles{})) {
        return;
    }
    const reader game{m_opens, m_game};
    const writer calls{m_opens, m_game};
    const result<input_ptr> input = game.read<foreign::input>();
    if (!input || lucent::foreign::is_null(*input)) {
        return;
    }
    const result<heading> now = read_heading(game, *input);
    const std::optional<count_size> size = count_size_of(calls);
    if (!now || !size) {
        return;
    }
    m_state = view_state{.now = *now, .per_count = *size, .tick = tick};
    m_turns.emplace(m_model);
    parts.put(*m_state);
    parts.put(*m_turns);
}

auto view_domain::apply() -> void {
    const view_turn asked = m_model.pending();
    const bool is_asked = asked.pitch != 0.0F || asked.yaw != 0.0F;
    if (!is_asked || !kit::is_available(foreign::view_angles{})) {
        return;
    }
    const reader game{m_opens, m_game};
    const writer written{m_opens, m_game};
    const result<input_ptr> input = game.read<foreign::input>();
    if (!input || lucent::foreign::is_null(*input)) {
        return;
    }
    const result<heading> now = read_heading(game, *input);
    const std::optional<count_size> size = count_size_of(written);
    if (!now || !size) {
        return;
    }
    // Owed only once the view really turned.
    mouse_model next = m_model;
    const std::optional<heading> turned = next.turn(*now, *size);
    if (turned && write_heading(game, written, *input, *turned)) {
        m_model = next;
    }
}

auto view_domain::model() -> mouse_model& {
    return m_model;
}
}
