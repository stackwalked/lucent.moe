#include <lucent/refract/execution.hpp>

#include <algorithm>
#include <bit>
#include <expected>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/refract/function.hpp>
#include <lucent/refract/instruction.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/operation.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {
namespace {

// The values of the instruction being run.
struct frame {
    std::vector<u64> values;
    u64 address = 0;
};

auto value_of(const frame& current, value_id id) -> u64 {
    return current.values.at(std::to_underlying(id));
}

auto register_of(const machine& state, gpr reg) -> u64 {
    return state.registers.at(std::to_underlying(reg));
}

auto is_set(u64 flags, flag bit) -> bool {
    return (flags & mask_of(bit)) != 0;
}

auto bit_of(flag bit, u64 one_or_zero) -> u64 {
    return one_or_zero << std::to_underlying(bit);
}

// Two's complement sign extension of a value of that width to 64 bits.
auto sign_extended(u64 value, width size) -> u64 {
    const u64 sign = sign_bit_of(size);
    return ((value & mask_of(size)) ^ sign) - sign;
}

auto is_negative(u64 value, width size) -> bool {
    return (value & sign_bit_of(size)) != 0;
}

auto condition_holds(condition code, u64 flags) -> bool {
    const bool is_less = is_set(flags, flag::sign) != is_set(flags, flag::overflow);
    switch (code) {
    case condition::overflow:
        return is_set(flags, flag::overflow);
    case condition::no_overflow:
        return !is_set(flags, flag::overflow);
    case condition::below:
        return is_set(flags, flag::carry);
    case condition::above_or_equal:
        return !is_set(flags, flag::carry);
    case condition::equal:
        return is_set(flags, flag::zero);
    case condition::not_equal:
        return !is_set(flags, flag::zero);
    case condition::below_or_equal:
        return is_set(flags, flag::carry) || is_set(flags, flag::zero);
    case condition::above:
        return !is_set(flags, flag::carry) && !is_set(flags, flag::zero);
    case condition::sign:
        return is_set(flags, flag::sign);
    case condition::no_sign:
        return !is_set(flags, flag::sign);
    case condition::parity:
        return is_set(flags, flag::parity);
    case condition::no_parity:
        return !is_set(flags, flag::parity);
    case condition::less:
        return is_less;
    case condition::greater_or_equal:
        return !is_less;
    case condition::less_or_equal:
        return is_less || is_set(flags, flag::zero);
    case condition::greater:
        return !is_less && !is_set(flags, flag::zero);
    }
    LUCENT_UNREACHABLE();
}

// The width's value shifted right with its sign filled in, over all 64 bits.
auto shifted_arithmetic(u64 value, width size, u64 count) -> u64 {
    const u64 extended = sign_extended(value, size);
    const u64 shift = std::min<u64>(count, 63);
    return is_negative(value, size) ? ~(~extended >> shift) : extended >> shift;
}

auto rotate(u64 value, width size, u64 count, operator_kind kind) -> u64 {
    const u64 bits = bits_of(size);
    const u64 turn = count % bits;
    if (turn == 0) {
        return value;
    }
    const u64 left = kind == operator_kind::rotate_left ? turn : bits - turn;
    return ((value << left) | (value >> (bits - left))) & mask_of(size);
}

auto computed(const compute& operation, u64 lhs, u64 rhs) -> u64 {
    const width size = operation.size;
    const u64 mask = mask_of(size);
    const u64 left = lhs & mask;
    const u64 right = rhs & mask;
    const u64 bits = bits_of(size);
    switch (operation.kind) {
    case operator_kind::add:
        return (left + right) & mask;
    case operator_kind::subtract:
        return (left - right) & mask;
    case operator_kind::multiply:
        return (left * right) & mask;
    case operator_kind::bit_and:
        return left & right;
    case operator_kind::bit_or:
        return left | right;
    case operator_kind::bit_xor:
        return left ^ right;
    case operator_kind::shift_left:
        return right >= bits ? 0 : (left << right) & mask;
    case operator_kind::shift_right:
        return right >= bits ? 0 : left >> right;
    case operator_kind::shift_right_arithmetic:
        return shifted_arithmetic(left, size, right) & mask;
    case operator_kind::rotate_left:
    case operator_kind::rotate_right:
        return rotate(left, size, right, operation.kind);
    }
    LUCENT_UNREACHABLE();
}

// Zero, sign and parity, which every rule but the rotates derives from the result alone. Parity
// counts the low byte only.
auto result_flags(u64 result, width size) -> u64 {
    return bit_of(flag::zero, u64{(result & mask_of(size)) == 0})
           | bit_of(flag::sign, u64{is_negative(result, size)})
           | bit_of(flag::parity, u64{std::popcount(result & 0xffU) % 2 == 0});
}

auto adjust_flag(u64 lhs, u64 rhs, u64 result) -> u64 {
    return bit_of(flag::adjust, ((lhs ^ rhs ^ result) >> 4U) & 1U);
}

struct flag_inputs {
    width size = width::qword;
    u64 lhs = 0;
    u64 rhs = 0;
    u64 result = 0;
    u64 previous = 0;
};

auto add_flags(const flag_inputs& inputs, u64 carry) -> u64 {
    const u64 overflow =
        (inputs.lhs ^ inputs.result) & (inputs.rhs ^ inputs.result) & sign_bit_of(inputs.size);
    return bit_of(flag::carry, carry)
           | bit_of(flag::overflow, u64{overflow != 0})
           | adjust_flag(inputs.lhs, inputs.rhs, inputs.result)
           | result_flags(inputs.result, inputs.size);
}

auto subtract_flags(const flag_inputs& inputs, u64 borrow) -> u64 {
    const u64 overflow =
        (inputs.lhs ^ inputs.rhs) & (inputs.lhs ^ inputs.result) & sign_bit_of(inputs.size);
    return bit_of(flag::carry, borrow)
           | bit_of(flag::overflow, u64{overflow != 0})
           | adjust_flag(inputs.lhs, inputs.rhs, inputs.result)
           | result_flags(inputs.result, inputs.size);
}

auto has_signed_overflow(const flag_inputs& inputs) -> bool {
    const auto lhs = std::bit_cast<i64>(sign_extended(inputs.lhs, inputs.size));
    const auto rhs = std::bit_cast<i64>(sign_extended(inputs.rhs, inputs.size));
    i64 product = 0;
    if (__builtin_mul_overflow(lhs, rhs, &product)) {
        return true;
    }
    const auto bits = std::bit_cast<u64>(product);
    return sign_extended(bits, inputs.size) != bits;
}

// The last bit a shift left by count moved out; 0 past the width, where the ISA leaves it
// undefined.
auto carry_out_left(const flag_inputs& inputs) -> u64 {
    const u64 bits = bits_of(inputs.size);
    return inputs.rhs > bits ? 0 : (inputs.lhs >> (bits - inputs.rhs)) & 1U;
}

auto carry_out_right(const flag_inputs& inputs) -> u64 {
    return inputs.rhs > bits_of(inputs.size) ? 0 : (inputs.lhs >> (inputs.rhs - 1)) & 1U;
}

auto top_bit(u64 value, width size) -> u64 {
    return u64{is_negative(value, size)};
}

auto shift_flags(flag_rule rule, const flag_inputs& inputs) -> u64 {
    const u64 shared = result_flags(inputs.result, inputs.size);
    if (rule == flag_rule::shift_left) {
        const u64 carry = carry_out_left(inputs);
        return bit_of(flag::carry, carry)
               | bit_of(flag::overflow, top_bit(inputs.result, inputs.size) ^ carry)
               | shared;
    }
    if (rule == flag_rule::shift_right) {
        return bit_of(flag::carry, carry_out_right(inputs))
               | bit_of(flag::overflow, top_bit(inputs.lhs, inputs.size))
               | shared;
    }
    const u64 carry = shifted_arithmetic(inputs.lhs, inputs.size, inputs.rhs - 1) & 1U;
    return bit_of(flag::carry, carry) | shared;
}

auto rotate_flags(flag_rule rule, const flag_inputs& inputs) -> u64 {
    const u64 top = top_bit(inputs.result, inputs.size);
    if (rule == flag_rule::rotate_left) {
        const u64 carry = inputs.result & 1U;
        return bit_of(flag::carry, carry) | bit_of(flag::overflow, top ^ carry);
    }
    const u64 below_top = (inputs.result >> (bits_of(inputs.size) - 2)) & 1U;
    return bit_of(flag::carry, top) | bit_of(flag::overflow, top ^ below_top);
}

// The arithmetic flags the rule writes; the rule's callers keep the rest of the previous image.
auto written_flags(flag_rule rule, const flag_inputs& inputs) -> u64 {
    const u64 carry_in = u64{is_set(inputs.previous, flag::carry)};
    const u64 lhs = inputs.lhs;
    const u64 rhs = inputs.rhs;
    const u64 result = inputs.result;
    switch (rule) {
    case flag_rule::logic:
        return result_flags(result, inputs.size);
    case flag_rule::add:
        return add_flags(inputs, u64{result < lhs});
    case flag_rule::add_with_carry:
        return add_flags(inputs, u64{carry_in != 0 ? result <= lhs : result < lhs});
    case flag_rule::subtract:
        return subtract_flags(inputs, u64{lhs < rhs});
    case flag_rule::subtract_with_borrow:
        return subtract_flags(inputs, u64{carry_in != 0 ? lhs <= rhs : lhs < rhs});
    case flag_rule::increment:
        return add_flags(inputs, carry_in);
    case flag_rule::decrement:
        return subtract_flags(inputs, carry_in);
    case flag_rule::multiply_signed: {
        const u64 overflow = u64{has_signed_overflow(inputs)};
        return bit_of(flag::carry, overflow)
               | bit_of(flag::overflow, overflow)
               | result_flags(result, inputs.size);
    }
    case flag_rule::shift_left:
    case flag_rule::shift_right:
    case flag_rule::shift_right_arithmetic:
        return shift_flags(rule, inputs);
    case flag_rule::rotate_left:
    case flag_rule::rotate_right:
        return rotate_flags(rule, inputs);
    }
    LUCENT_UNREACHABLE();
}

// Which flags the rule replaces: rotates touch only carry and overflow.
auto replaced_flags(flag_rule rule) -> u64 {
    switch (rule) {
    case flag_rule::rotate_left:
    case flag_rule::rotate_right:
        return mask_of(flag::carry) | mask_of(flag::overflow);
    case flag_rule::increment:
    case flag_rule::decrement:
    case flag_rule::logic:
    case flag_rule::add:
    case flag_rule::add_with_carry:
    case flag_rule::subtract:
    case flag_rule::subtract_with_borrow:
    case flag_rule::multiply_signed:
    case flag_rule::shift_left:
    case flag_rule::shift_right:
    case flag_rule::shift_right_arithmetic:
        return arithmetic_flags;
    }
    LUCENT_UNREACHABLE();
}

auto is_count_rule(flag_rule rule) -> bool {
    switch (rule) {
    case flag_rule::shift_left:
    case flag_rule::shift_right:
    case flag_rule::shift_right_arithmetic:
    case flag_rule::rotate_left:
    case flag_rule::rotate_right:
        return true;
    case flag_rule::logic:
    case flag_rule::add:
    case flag_rule::add_with_carry:
    case flag_rule::subtract:
    case flag_rule::subtract_with_borrow:
    case flag_rule::increment:
    case flag_rule::decrement:
    case flag_rule::multiply_signed:
        return false;
    }
    LUCENT_UNREACHABLE();
}

// What an operation produced: its value, or 0 for one that produces none.
using produced = std::expected<u64, fault>;

auto memory_fault(const frame& current, u64 access) -> std::unexpected<fault> {
    return std::unexpected{fault{
        .kind = fault_kind::unmapped_memory,
        .address = current.address,
        .access = access,
    }};
}

auto execute(const constant& operation, const frame& /*current*/, const machine& /*state*/)
    -> produced {
    return operation.value;
}

auto execute(const read_register& operation, const frame& /*current*/, const machine& state)
    -> produced {
    return register_of(state, operation.source) & mask_of(operation.size);
}

auto execute(const write_register& operation, const frame& current, machine& state) -> produced {
    u64& target = state.registers.at(std::to_underlying(operation.target));
    const u64 value = value_of(current, operation.value) & mask_of(operation.size);
    switch (operation.size) {
    case width::dword:
    case width::qword:
        target = value;
        return 0;
    case width::byte:
    case width::word:
        target = (target & ~mask_of(operation.size)) | value;
        return 0;
    }
    LUCENT_UNREACHABLE();
}

auto execute(const read_flag& operation, const frame& /*current*/, const machine& state)
    -> produced {
    return u64{is_set(state.flags, operation.bit)};
}

auto execute(const test_condition& operation, const frame& /*current*/, const machine& state)
    -> produced {
    return u64{condition_holds(operation.code, state.flags)};
}

auto execute(const load& operation, const frame& current, const machine& state) -> produced {
    const memory_access access{
        .address = value_of(current, operation.address),
        .size = operation.size,
    };
    if (!is_mapped(state.memory, access)) {
        return memory_fault(current, access.address);
    }
    return value_at(state.memory, access);
}

auto execute(const store& operation, const frame& current, machine& state) -> produced {
    const memory_access access{
        .address = value_of(current, operation.address),
        .size = operation.size,
    };
    if (!is_mapped(state.memory, access)) {
        return memory_fault(current, access.address);
    }
    write(state.memory, access, value_of(current, operation.value));
    return 0;
}

auto execute(const compute& operation, const frame& current, const machine& /*state*/) -> produced {
    return computed(operation, value_of(current, operation.lhs), value_of(current, operation.rhs));
}

auto execute(const extend& operation, const frame& current, const machine& /*state*/) -> produced {
    const u64 source = value_of(current, operation.source);
    switch (operation.kind) {
    case extension::zero:
        return source & mask_of(operation.from);
    case extension::sign:
        return sign_extended(source, operation.from);
    }
    LUCENT_UNREACHABLE();
}

auto execute(const select& operation, const frame& current, const machine& /*state*/) -> produced {
    const bool holds = value_of(current, operation.condition) != 0;
    return value_of(current, holds ? operation.if_true : operation.if_false);
}

auto execute(const update_flags& operation, const frame& current, machine& state) -> produced {
    const u64 mask = mask_of(operation.size);
    const flag_inputs inputs{
        .size = operation.size,
        .lhs = value_of(current, operation.lhs) & mask,
        .rhs = value_of(current, operation.rhs) & mask,
        .result = value_of(current, operation.result) & mask,
        .previous = state.flags,
    };
    if (is_count_rule(operation.rule) && inputs.rhs == 0) {
        return 0;
    }
    const u64 replaced = replaced_flags(operation.rule);
    state.flags = (state.flags & ~replaced) | (written_flags(operation.rule, inputs) & replaced);
    return 0;
}

auto next_address(const instruction& lifted, const frame& current) -> u64 {
    const u64 following = lifted.address + narrow<u64>(lifted.length);
    return match(
        lifted.next,
        [&](const fall_through&) { return following; },
        [](const jump& jumped) { return jumped.target; },
        [&](const branch& taken) {
            return value_of(current, taken.condition) != 0 ? taken.target : following;
        },
        [&](const leave& leaving) { return value_of(current, leaving.target); }
    );
}

auto is_leaving(const flow& next) -> bool {
    return match(
        next,
        [](const fall_through&) { return false; },
        [](const jump&) { return false; },
        [](const branch&) { return false; },
        [](const leave&) { return true; }
    );
}

}

auto step(const instruction& lifted, machine& state) -> std::expected<u64, fault> {
    frame current{.values = {}, .address = lifted.address};
    current.values.reserve(lifted.operations.size());
    for (const operation& each : lifted.operations) {
        const u64 value = LUCENT_TRY(match(each, [&](const auto& kind) {
            return execute(kind, current, state);
        }));
        current.values.push_back(value);
    }
    return next_address(lifted, current);
}

auto run(const function& lifted, machine& state, isize step_limit) -> std::expected<u64, fault> {
    u64 address = lifted.entry;
    for (isize steps = 0; steps < step_limit; ++steps) {
        const instruction* const current = instruction_at(lifted, address);
        // Lifting proved every jump and branch target is an instruction of the function.
        LUCENT_INVARIANT(current != nullptr);
        address = LUCENT_TRY(step(*current, state));
        if (is_leaving(current->next)) {
            return address;
        }
    }
    return std::unexpected{fault{.kind = fault_kind::step_limit, .address = address, .access = 0}};
}

}
