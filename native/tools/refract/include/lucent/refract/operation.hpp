#pragma once

#include <variant>

#include <lucent/refract/machine.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {

// The value the operation at that index of an instruction produced. Only constant, the reads,
// test_condition, load, compute, extend and select produce one. Values never cross instructions:
// everything that does flows through registers, flags and memory, so later passes see every
// dependency there.
enum class value_id : u8 {};

// Operators over two values of one width: the inputs are cut to the width, and so is the result.
// A shift count of the width or more shifts everything out (the arithmetic shift fills with the
// sign); a rotate turns by the count modulo the width. x86's own count masking is the lifter's
// job, as an explicit bit_and.
enum class operator_kind : u8 {
    add,
    subtract,
    multiply,
    bit_and,
    bit_or,
    bit_xor,
    shift_left,
    shift_right,
    shift_right_arithmetic,
    rotate_left,
    rotate_right,
};

// How an update_flags derives the arithmetic flags, by the x86 instruction family it models
// (Intel SDM vol. 2, each instruction's "Flags Affected"). A flag the SDM leaves undefined gets a
// value the rule chooses, never one a program may rely on.
// - add_with_carry and subtract_with_borrow read the carry in from the flags being replaced.
// - increment and decrement keep the carry flag.
// - The shifts and rotates read the masked count as rhs and change nothing when it is 0; rotates
//   only ever write carry and overflow.
// - logic reads only the result.
enum class flag_rule : u8 {
    logic,
    add,
    add_with_carry,
    subtract,
    subtract_with_borrow,
    increment,
    decrement,
    multiply_signed,
    shift_left,
    shift_right,
    shift_right_arithmetic,
    rotate_left,
    rotate_right,
};

// The x86 condition codes in their encoding order, the tttn field of Jcc, SETcc and CMOVcc (Intel
// SDM vol. 2, B.1.4.7), which is how the lifter reads them off an opcode.
enum class condition : u8 {
    overflow,
    no_overflow,
    below,
    above_or_equal,
    equal,
    not_equal,
    below_or_equal,
    above,
    sign,
    no_sign,
    parity,
    no_parity,
    less,
    greater_or_equal,
    less_or_equal,
    greater,
};

enum class extension : u8 { zero, sign };

struct constant {
    u64 value = 0;

    auto operator==(const constant&) const -> bool = default;
};

// The register's low bits, zero-extended.
struct read_register {
    gpr source = gpr::rax;
    width size = width::qword;

    auto operator==(const read_register&) const -> bool = default;
};

// Writes as x86 does: a dword zeroes the upper half, a byte or word keeps the bits above it.
struct write_register {
    gpr target = gpr::rax;
    width size = width::qword;
    value_id value{};

    auto operator==(const write_register&) const -> bool = default;
};

// 0 or 1.
struct read_flag {
    flag bit = flag::carry;

    auto operator==(const read_flag&) const -> bool = default;
};

// 1 when the condition holds over the current flags, else 0.
struct test_condition {
    condition code = condition::overflow;

    auto operator==(const test_condition&) const -> bool = default;
};

struct load {
    value_id address{};
    width size = width::qword;

    auto operator==(const load&) const -> bool = default;
};

struct store {
    value_id address{};
    value_id value{};
    width size = width::qword;

    auto operator==(const store&) const -> bool = default;
};

struct compute {
    operator_kind kind = operator_kind::add;
    width size = width::qword;
    value_id lhs{};
    value_id rhs{};

    auto operator==(const compute&) const -> bool = default;
};

// The source's low `from` bits, extended to 64.
struct extend {
    value_id source{};
    width from = width::qword;
    extension kind = extension::zero;

    auto operator==(const extend&) const -> bool = default;
};

// if_true when the condition is nonzero, else if_false.
struct select {
    value_id condition{};
    value_id if_true{};
    value_id if_false{};

    auto operator==(const select&) const -> bool = default;
};

// Replaces the arithmetic flags as the rule says, from the operation's inputs and result. Kept
// apart from the compute that made the result, so flag liveness can drop it whole.
struct update_flags {
    flag_rule rule = flag_rule::logic;
    width size = width::qword;
    value_id lhs{};
    value_id rhs{};
    value_id result{};

    auto operator==(const update_flags&) const -> bool = default;
};

using operation = std::variant<
    constant,
    read_register,
    write_register,
    read_flag,
    test_condition,
    load,
    store,
    compute,
    extend,
    select,
    update_flags>;

}
