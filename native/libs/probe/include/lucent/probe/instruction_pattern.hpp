#pragma once

#include <array>
#include <cstddef>
#include <ranges>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {
namespace detail {

// A mnemonic, register, variable or capture as the pattern text spells it.
struct pattern_name {
    static constexpr isize max_size = 15;

    std::array<char, max_size + 1> letters{};
    u8 size = 0;

    constexpr auto view() const -> std::string_view {
        return {letters.data(), size};
    }
};

enum class operand_rule : u8 { any, exact_register, variable, number, capture, memory };
enum class base_rule : u8 { any, exact_register, variable, rip };
enum class index_rule : u8 { none, any, exact_register, variable };
enum class displacement_rule : u8 { exact, any, capture };

struct memory_pattern {
    base_rule base = base_rule::any;
    index_rule index = index_rule::none;
    displacement_rule displacement = displacement_rule::exact;
    u8 scale = 0;
    // The variable or capture a rule names, as its index.
    u8 base_slot = 0;
    u8 index_slot = 0;
    u8 displacement_slot = 0;
    i64 displacement_value = 0;
    pattern_name base_name;
    pattern_name index_name;
};

struct operand_pattern {
    operand_rule rule = operand_rule::any;
    // The variable or capture it names, as its index.
    u8 slot = 0;
    i64 number = 0;
    pattern_name register_name;
    memory_pattern memory;
};

struct step_pattern {
    static constexpr isize max_operands = 4;

    bool is_gap = false;
    bool is_any_mnemonic = false;
    u8 operand_count = 0;
    pattern_name mnemonic;
    std::array<operand_pattern, max_operands> operands{};
};

}

// x64 instructions to look for, written as the disassembler (Zydis) prints them in lowercase,
// steps separated by ';':
//
//   "movsxd rax, ecx; lea rcx, [rip+$table]; shl rax, 6; add rax, rcx; ret"
//
// A step is a mnemonic ('?' for any) and its operands, or "..." for up to max_gap instructions of
// anything between two steps. An operand is one of:
//   ?        anything;
//   rcx      that register;
//   %name    any register, the same one at every step naming it. Registers compare as their
//            full 64-bit register, so %i is ecx in one step and rcx in the next;
//   0x70, -1 that immediate, compared at the operand's width;
//   $name    an immediate, or a branch's target as an RVA, captured;
//   [base + index*scale + displacement]  memory, sizes ignored. The base is a register, %name,
//            rip or '?'; the index a register, %name or '?', the scale 1, 2, 4 or 8. The
//            displacement is a number, '?' for any, or $name to capture it: off rip, the place it
//            names as an RVA. Without one the displacement is 0.
// Malformed text doesn't compile. A mnemonic or register the disassembler doesn't know fails the
// invariant on first use.
class instruction_pattern final {
public:
    static constexpr isize max_steps = 16;
    static constexpr isize max_names = 8;
    static constexpr isize max_gap = 16;

    consteval explicit instruction_pattern(std::string_view text) noexcept {
        for (const auto part : text | std::views::split(';')) {
            add_step(trimmed(std::string_view{part}));
        }
        LUCENT_INVARIANT(m_step_count > 0);
        LUCENT_INVARIANT(!m_steps.front().is_gap);
        LUCENT_INVARIANT(!m_steps.at(static_cast<usize>(m_step_count - 1)).is_gap);
    }

    // A capture's index in a match's captures. A name the text doesn't capture doesn't compile.
    consteval auto capture(std::string_view name) const -> isize {
        for (isize index = 0; index < m_capture_count; ++index) {
            if (m_captures.at(static_cast<usize>(index)).view() == name) {
                return index;
            }
        }
        LUCENT_INVARIANT(false);
        return 0;
    }

    constexpr auto steps() const -> std::span<const detail::step_pattern> {
        return std::span{m_steps}.first(static_cast<usize>(m_step_count));
    }

private:
    static consteval auto trimmed(std::string_view text) -> std::string_view {
        while (!text.empty() && text.front() == ' ') {
            text.remove_prefix(1);
        }
        while (!text.empty() && text.back() == ' ') {
            text.remove_suffix(1);
        }
        return text;
    }

    static consteval auto is_name_letter(char letter) -> bool {
        return (letter >= 'a' && letter <= 'z')
               || (letter >= '0' && letter <= '9')
               || letter == '_';
    }

    static consteval auto is_number(std::string_view text) -> bool {
        return !text.empty()
               && ((text.front() >= '0' && text.front() <= '9') || text.front() == '-');
    }

    static consteval auto name_of(std::string_view text) -> detail::pattern_name {
        LUCENT_INVARIANT(
            !text.empty() && std::cmp_less_equal(text.size(), detail::pattern_name::max_size)
        );
        detail::pattern_name made{};
        for (const char letter : text) {
            LUCENT_INVARIANT(is_name_letter(letter));
            made.letters.at(made.size) = letter;
            ++made.size;
        }
        return made;
    }

    static consteval auto digit_value(char digit) -> i64 {
        if (digit >= '0' && digit <= '9') {
            return digit - '0';
        }
        LUCENT_INVARIANT(digit >= 'a' && digit <= 'f');
        return digit - 'a' + 10;
    }

    static consteval auto number_of(std::string_view text) -> i64 {
        const bool is_negative = text.starts_with('-');
        if (is_negative) {
            text.remove_prefix(1);
        }
        i64 base = 10;
        if (text.starts_with("0x")) {
            base = 16;
            text.remove_prefix(2);
        }
        LUCENT_INVARIANT(!text.empty());
        i64 value = 0;
        for (const char digit : text) {
            const i64 part = digit_value(digit);
            LUCENT_INVARIANT(part < base);
            value = (value * base) + part;
        }
        return is_negative ? -value : value;
    }

    consteval auto variable_slot(std::string_view name) -> u8 {
        for (isize index = 0; index < m_variable_count; ++index) {
            if (m_variables.at(static_cast<usize>(index)).view() == name) {
                return static_cast<u8>(index);
            }
        }
        LUCENT_INVARIANT(m_variable_count < max_names);
        m_variables.at(static_cast<usize>(m_variable_count)) = name_of(name);
        return static_cast<u8>(m_variable_count++);
    }

    // Each capture is named once: two places reading one name would have to agree, which is what
    // a variable is for.
    consteval auto capture_slot(std::string_view name) -> u8 {
        for (isize index = 0; index < m_capture_count; ++index) {
            LUCENT_INVARIANT(m_captures.at(static_cast<usize>(index)).view() != name);
        }
        LUCENT_INVARIANT(m_capture_count < max_names);
        m_captures.at(static_cast<usize>(m_capture_count)) = name_of(name);
        return static_cast<u8>(m_capture_count++);
    }

    consteval auto add_step(std::string_view text) -> void {
        LUCENT_INVARIANT(!text.empty() && m_step_count < max_steps);
        detail::step_pattern& made = m_steps.at(static_cast<usize>(m_step_count));
        const bool follows_gap =
            m_step_count > 0 && m_steps.at(static_cast<usize>(m_step_count - 1)).is_gap;
        ++m_step_count;
        if (text == "...") {
            LUCENT_INVARIANT(!follows_gap);
            made.is_gap = true;
            return;
        }
        const usize space = text.find(' ');
        const std::string_view mnemonic = text.substr(0, space);
        if (mnemonic == "?") {
            made.is_any_mnemonic = true;
        } else {
            made.mnemonic = name_of(mnemonic);
        }
        if (space == std::string_view::npos) {
            return;
        }
        for (const auto part : text.substr(space + 1) | std::views::split(',')) {
            LUCENT_INVARIANT(made.operand_count < detail::step_pattern::max_operands);
            made.operands.at(made.operand_count) = operand_of(trimmed(std::string_view{part}));
            ++made.operand_count;
        }
    }

    consteval auto operand_of(std::string_view text) -> detail::operand_pattern {
        LUCENT_INVARIANT(!text.empty());
        detail::operand_pattern made{};
        if (text == "?") {
            made.rule = detail::operand_rule::any;
        } else if (text.starts_with('%')) {
            made.rule = detail::operand_rule::variable;
            made.slot = variable_slot(text.substr(1));
        } else if (text.starts_with('$')) {
            made.rule = detail::operand_rule::capture;
            made.slot = capture_slot(text.substr(1));
        } else if (text.starts_with('[')) {
            LUCENT_INVARIANT(text.ends_with(']'));
            made.rule = detail::operand_rule::memory;
            made.memory = memory_of(text.substr(1, text.size() - 2));
        } else if (is_number(text)) {
            made.rule = detail::operand_rule::number;
            made.number = number_of(text);
        } else {
            made.rule = detail::operand_rule::exact_register;
            made.register_name = name_of(text);
        }
        return made;
    }

    consteval auto memory_of(std::string_view text) -> detail::memory_pattern {
        detail::memory_pattern made{};
        bool is_first = true;
        char sign = '+';
        usize start = 0;
        for (usize at = 0; at <= text.size(); ++at) {
            const bool ends_term = at == text.size() || text.at(at) == '+' || text.at(at) == '-';
            if (!ends_term) {
                continue;
            }
            const std::string_view term = trimmed(text.substr(start, at - start));
            if (is_first) {
                base_of(made, term);
                is_first = false;
            } else {
                term_of(made, term, sign);
            }
            if (at < text.size()) {
                sign = text.at(at);
            }
            start = at + 1;
        }
        return made;
    }

    consteval auto base_of(detail::memory_pattern& made, std::string_view term) -> void {
        LUCENT_INVARIANT(!term.empty());
        if (term == "?") {
            made.base = detail::base_rule::any;
        } else if (term == "rip") {
            made.base = detail::base_rule::rip;
        } else if (term.starts_with('%')) {
            made.base = detail::base_rule::variable;
            made.base_slot = variable_slot(term.substr(1));
        } else {
            made.base = detail::base_rule::exact_register;
            made.base_name = name_of(term);
        }
    }

    consteval auto index_of(detail::memory_pattern& made, std::string_view term, u8 scale) -> void {
        LUCENT_INVARIANT(made.index == detail::index_rule::none);
        LUCENT_INVARIANT(scale == 1 || scale == 2 || scale == 4 || scale == 8);
        made.scale = scale;
        if (term == "?") {
            made.index = detail::index_rule::any;
        } else if (term.starts_with('%')) {
            made.index = detail::index_rule::variable;
            made.index_slot = variable_slot(term.substr(1));
        } else {
            made.index = detail::index_rule::exact_register;
            made.index_name = name_of(term);
        }
    }

    consteval auto term_of(detail::memory_pattern& made, std::string_view term, char sign) -> void {
        LUCENT_INVARIANT(!term.empty());
        if (const usize star = term.find('*'); star != std::string_view::npos) {
            LUCENT_INVARIANT(sign == '+');
            index_of(
                made,
                trimmed(term.substr(0, star)),
                static_cast<u8>(number_of(trimmed(term.substr(star + 1))))
            );
        } else if (term == "?") {
            made.displacement = detail::displacement_rule::any;
        } else if (term.starts_with('$')) {
            LUCENT_INVARIANT(sign == '+');
            made.displacement = detail::displacement_rule::capture;
            made.displacement_slot = capture_slot(term.substr(1));
        } else if (is_number(term)) {
            made.displacement = detail::displacement_rule::exact;
            made.displacement_value = sign == '-' ? -number_of(term) : number_of(term);
        } else {
            LUCENT_INVARIANT(sign == '+');
            index_of(made, term, 1);
        }
    }

    std::array<detail::step_pattern, max_steps> m_steps{};
    isize m_step_count = 0;
    std::array<detail::pattern_name, max_names> m_variables{};
    isize m_variable_count = 0;
    std::array<detail::pattern_name, max_names> m_captures{};
    isize m_capture_count = 0;
};

// One place a pattern matched, and what its captures read there, by capture index.
struct pattern_match {
    u32 rva = 0;
    // Just past the last instruction matched.
    u32 end = 0;
    std::array<u64, instruction_pattern::max_names> captures{};
};

// Where the pattern matches the code in the range, in address order: at most one match per
// starting instruction, the one that ends first. Decoding is linear, as references_in's is.
auto matches_in(const module_file& module, pe::rva_range range, const instruction_pattern& pattern)
    -> std::vector<pattern_match>;

// Where it matches anywhere in the executable sections: the .pdata functions and the gaps between
// them, as code_index reads them.
auto matches_in_code(const module_file& module, const instruction_pattern& pattern)
    -> std::vector<pattern_match>;

// What one capture read at each match.
auto captured(std::span<const pattern_match> matches, isize capture) -> std::vector<u64>;

}
