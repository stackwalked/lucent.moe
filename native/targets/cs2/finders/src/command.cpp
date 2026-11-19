#include <array>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>

#include "classes.hpp"
#include "code.hpp"
#include "lucent/pe/image_view.hpp"
#include "searches.hpp"

// Every finder here was written against one build and checked on it by the generator:
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9, Steam build
// 26772654, 2026-11-18)
//
// The command's messages are protobuf's generated code. A serializer tests a field's has-bit,
// loads the field and writes its wire tag ((number << 3) | wire type), so a field is found where
// its serializer writes its tag right after loading it under its bit: the message's RTTI picks
// the class, the tag the field, the bit its presence. The bits each finder matches are the ones
// the command domain sets.
namespace lucent::finder {
namespace {

constexpr std::string_view step_class = "CSubtickMoveStep";
constexpr std::string_view buttons_class = "CInButtonStatePB";
constexpr std::string_view base_class = "CBaseUserCmdPB";

// found: each serializer opens by loading the has-bits into the register it tests, after taking
// `this` into rdi (CSubtickMoveStep client+0x4f2d90, CInButtonStatePB +0x4f26a0, CBaseUserCmdPB
// +0x4f4540, all at 0x10)
// breaks: the serializer reshaped: none
constexpr probe::instruction_pattern loads_has_bits{
    "mov %bits, [rcx+$bits]; ...; mov rdi, rcx; test %bits, ?"
};

// Integers, written as varints: the load, then the tag. found: button (field 1, tag 8) under
// bit 1; the button words (tags 8, 0x10, 0x18) under bits 1, 2 and 4.
// breaks: the field renumbered, retyped or its bit moved: none
constexpr probe::instruction_pattern bit1_varint8{
    "test %bits, 1; jz ?; ...; mov ?, [%m+$field]; lea ?, [?+1]; mov [?], 8"
};
constexpr probe::instruction_pattern bit2_varint16{
    "test %bits, 2; jz ?; ...; mov ?, [%m+$field]; lea ?, [?+1]; mov [?], 0x10"
};
constexpr probe::instruction_pattern bit4_varint24{
    "test %bits, 4; jz ?; ...; mov ?, [%m+$field]; lea ?, [?+1]; mov [?], 0x18"
};

// A bool: pressed (field 2, tag 0x10) under bit 2.
constexpr probe::instruction_pattern bit2_bool16{
    "test %bits, 2; jz ?; ...; movzx eax, [%m+$field]; test al, al; mov [?], 0x10"
};

// Floats: when (field 3, tag 0x1d) under bit 4, the analog deltas (4 and 5, tags 0x25 and 0x2d)
// under bits 8 and 0x10, the view deltas (8 and 9, tags 0x45 and 0x4d) under 0x20 and 0x40.
constexpr probe::instruction_pattern bit4_float29{
    "test %bits, 4; jz ?; ...; movss xmm0, [%m+$field]; mov [?], 0x1d"
};
constexpr probe::instruction_pattern bit8_float37{
    "test %bits, 8; jz ?; ...; movss xmm0, [%m+$field]; mov [?], 0x25"
};
constexpr probe::instruction_pattern bit16_float45{
    "test %bits, 0x10; jz ?; ...; movss xmm0, [%m+$field]; mov [?], 0x2d"
};
constexpr probe::instruction_pattern bit32_float69{
    "test %bits, 0x20; jz ?; ...; movss xmm0, [%m+$field]; mov [?], 0x45"
};
constexpr probe::instruction_pattern bit64_float77{
    "test %bits, 0x40; jz ?; ...; movss xmm0, [%m+$field]; mov [?], 0x4d"
};

// The base command's button state, a submessage: field 3 under bit 2.
constexpr probe::instruction_pattern bit2_message3{
    "test %bits, 2; jz ?; mov rax, [%m+$field]; mov ecx, 3"
};

// The mouse counts, int32 varints: fields 11 and 12 (tags 0x58 and 0x60) under bits 12 and 13.
constexpr probe::instruction_pattern bit12_varint88{
    "bt %bits, 0xc; jnb ?; ...; movsxd rax, [%m+$field]; lea ?, [?+1]; mov [?], 0x58"
};
constexpr probe::instruction_pattern bit13_varint96{
    "bt %bits, 0xd; jnb ?; ...; movsxd rax, [%m+$field]; lea ?, [?+1]; mov [?], 0x60"
};

// Every field pattern captures the field alone.
constexpr isize field_capture = bit1_varint8.capture("field");
static_assert(
    bit2_varint16.capture("field") == field_capture
    && bit4_varint24.capture("field") == field_capture
    && bit2_bool16.capture("field") == field_capture
    && bit4_float29.capture("field") == field_capture
    && bit8_float37.capture("field") == field_capture
    && bit16_float45.capture("field") == field_capture
    && bit32_float69.capture("field") == field_capture
    && bit64_float77.capture("field") == field_capture
    && bit2_message3.capture("field") == field_capture
    && bit12_varint88.capture("field") == field_capture
    && bit13_varint96.capture("field") == field_capture
);

auto field_in(
    const probe::module_file& module,
    std::string_view name,
    const probe::instruction_pattern& pattern
) -> probe::finding {
    return captured_in_class(module, name, pattern, field_capture);
}

auto step_has_bits(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return captured_in_class(module, step_class, loads_has_bits, loads_has_bits.capture("bits"));
}

auto buttons_has_bits(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return captured_in_class(module, buttons_class, loads_has_bits, loads_has_bits.capture("bits"));
}

auto base_has_bits(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return captured_in_class(module, base_class, loads_has_bits, loads_has_bits.capture("bits"));
}

auto step_button(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit1_varint8);
}

auto step_pressed(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit2_bool16);
}

auto step_when(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit4_float29);
}

auto step_forward(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit8_float37);
}

auto step_left(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit16_float45);
}

auto step_pitch(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit32_float69);
}

auto step_yaw(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, step_class, bit64_float77);
}

auto buttons_held(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, buttons_class, bit1_varint8);
}

auto buttons_changed(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, buttons_class, bit2_varint16);
}

auto buttons_scroll(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, buttons_class, bit4_varint24);
}

auto base_buttons(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, base_class, bit2_message3);
}

auto base_mouse_dx(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, base_class, bit12_varint88);
}

auto base_mouse_dy(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return field_in(module, base_class, bit13_varint96);
}

// The base command's parse of field 18 (tag 0x92), the subtick steps, as protobuf's Add: reuse a
// cleared element while the rep has one, else New one in the field's arena and AddAllocated it.
// found: CBaseUserCmdPB's parser (client+0x4f3d50), case 18: rep at 0x28, count at 0x20, the
// arena and the field at 0x18, the element count at [rep], elements from [rep+8]; New
// +0x4f5700, AddAllocated +0x122ef80
// breaks: the case reshaped or the field renumbered: none
constexpr probe::instruction_pattern parses_steps{
    "cmp %tag, 0x92; jnz ?; ...; mov rcx, [%m+$rep]; test rcx, rcx; jz ?; "
    "movsxd rdx, [%m+$count]; cmp edx, [rcx+$allocated]; ...; mov rcx, [%m+$arena]; call $new; "
    "mov rdx, rax; lea rcx, [%m+$field]; call $add"
};

// The game's own step adds when it builds a command: the same Add, inlined.
// found: the builder (client+0xb5ba30, CCSGOInput slot 5) and +0xb54060
// breaks: shape only; the adds reshaped: none
constexpr probe::instruction_pattern adds_step{
    "mov %rep, [rax+$rep]; lea %field, [rax+$field]; test %rep, %rep; jz ?; "
    "movsxd %i, [%field+8]; cmp %i, [%rep]; ...; mov rcx, [%field]; call $new; mov rdx, rax; "
    "mov rcx, %field; call $add"
};

// RepeatedPtrFieldBase's layout: arena, count, capacity, rep (foreign/user_cmd.hpp).
constexpr u64 count_offset = 8;
constexpr u64 rep_offset = 0x10;

auto parses(const probe::module_file& module) -> std::vector<probe::pattern_match> {
    std::vector<probe::pattern_match> found;
    for (const pe::runtime_function& slot : slot_functions(module, base_class)) {
        const pe::rva_range code{.rva = slot.begin, .size = slot.end - slot.begin};
        found.append_range(probe::matches_in(module, code, parses_steps));
    }
    return found;
}

auto capture_of(const probe::pattern_match& found, isize capture) -> u64 {
    return found.captures.at(static_cast<usize>(capture));
}

// The parse's field, where its count, rep and arena agree with RepeatedPtrFieldBase's layout.
auto steps_by_parse(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    std::vector<u64> fields;
    for (const probe::pattern_match& found : parses(module)) {
        const u64 field = capture_of(found, parses_steps.capture("field"));
        if (capture_of(found, parses_steps.capture("arena")) == field
            && capture_of(found, parses_steps.capture("count")) == field + count_offset
            && capture_of(found, parses_steps.capture("rep")) == field + rep_offset) {
            fields.push_back(field);
        }
    }
    return probe::one(fields);
}

auto steps_by_builder(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    std::vector<u64> fields;
    for (const probe::pattern_match& found : probe::matches_in_code(module, adds_step)) {
        const u64 field = capture_of(found, adds_step.capture("field"));
        if (capture_of(found, adds_step.capture("rep")) == field + rep_offset) {
            fields.push_back(field);
        }
    }
    return probe::one(fields);
}

auto new_by_parse(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(probe::captured(parses(module), parses_steps.capture("new")));
}

auto new_by_builder(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(probe::matches_in_code(module, adds_step), adds_step.capture("new"))
    );
}

auto add_by_parse(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(probe::captured(parses(module), parses_steps.capture("add")));
}

auto add_by_builder(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(probe::matches_in_code(module, adds_step), adds_step.capture("add"))
    );
}

// The rep's element count, which the step list starts with.
auto rep_list_by_parse(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(probe::captured(parses(module), parses_steps.capture("allocated")));
}

// The base command and the command's own button words, as the builder fills the base's button
// state from them: each word tested, then the base command's has-bits marked, then its button
// state taken (made when there is none).
// found: client+0xb5c966 in the builder (CCSGOInput slot 5): `cmp qword [cmd+0x60], 0` and the
// next two words, then `lea rax, [cmd+0x18]; lea rcx, [cmd+0x20]; lea r14, [cmd+0x40]`, the
// CSGOUserCmdPB's metadata, has-bits and base command
// breaks: shape only; the builder reshaped: none
constexpr probe::instruction_pattern tests_words{
    "cmp [%c+$held], 0; jnz ?; cmp [%c+?], 0; jnz ?; cmp [%c+?], 0; jnz ?; test %c, %c; "
    "jz ?; lea rax, [%c+?]; lea rcx, [%c+?]; lea ?, [%c+$base]"
};

// The base CreateMove's read of the view angles out of the command, with protobuf's defaults
// for a missing base command or angles.
// found: client+0xb62660, after GetUserCmd: `mov rcx, [cmd+0x40]` then `mov rcx, [base+0x40]`
// breaks: shape only; reshaped: none
constexpr probe::instruction_pattern reads_base{
    "lea rax, [rip+?]; mov rcx, [%c+$base]; test rcx, rcx; cmovnz rax, rcx; mov rcx, [rax+?]; "
    "lea rax, [rip+?]; test rcx, rcx; cmovnz rax, rcx"
};

// The builder copying the command's own three words into the base command's button state; the
// first of the three is the held word.
// found: client+0xb5ca49: `mov rdx, [cmd+0x60]` ... `mov [state+0x18], rdx`, then 0x68 and 0x70
// breaks: shape only; reshaped: none
constexpr probe::instruction_pattern copies_words{
    "mov rdx, [%c+$held]; ...; mov [rax+?], rdx; ...; mov rdx, [%c+?]; ...; mov [rax+?], rdx; ...; "
    "mov rdx, [%c+?]; ...; mov [rax+?], rdx"
};

auto base_by_builder(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(probe::matches_in_code(module, tests_words), tests_words.capture("base"))
    );
}

// Only the functions the input's slots call: the base CreateMove among them.
auto base_by_create_move(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(captured_in(
        module,
        callees_of(module, slot_functions(module, "CCSGOInput")),
        reads_base,
        reads_base.capture("base")
    ));
}

auto words_by_tests(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(probe::matches_in_code(module, tests_words), tests_words.capture("held"))
    );
}

auto words_by_copy(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    std::vector<pe::runtime_function> builders;
    for (const probe::pattern_match& found : probe::matches_in_code(module, tests_words)) {
        if (const std::optional<pe::runtime_function> holder =
                module.function_containing(found.rva)) {
            builders.push_back(*holder);
        }
    }
    return probe::one(captured_in(module, builders, copies_words, copies_words.capture("held")));
}

constexpr auto semantic(std::string_view name, decltype(probe::finder::run) run) -> probe::finder {
    return probe::finder{
        .name = name,
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = run,
    };
}

constexpr auto shape(std::string_view name, decltype(probe::finder::run) run) -> probe::finder {
    return probe::finder{.name = name, .rests_on = probe::basis::shape, .reason = "", .run = run};
}

constexpr std::array step_has_bits_finders{
    semantic("CSubtickMoveStep's serializer", &step_has_bits),
};
constexpr std::array buttons_has_bits_finders{
    semantic("CInButtonStatePB's serializer", &buttons_has_bits),
};
constexpr std::array base_has_bits_finders{semantic("CBaseUserCmdPB's serializer", &base_has_bits)};
constexpr std::array step_button_finders{semantic("CSubtickMoveStep field 1", &step_button)};
constexpr std::array step_pressed_finders{semantic("CSubtickMoveStep field 2", &step_pressed)};
constexpr std::array step_when_finders{semantic("CSubtickMoveStep field 3", &step_when)};
constexpr std::array step_forward_finders{semantic("CSubtickMoveStep field 4", &step_forward)};
constexpr std::array step_left_finders{semantic("CSubtickMoveStep field 5", &step_left)};
constexpr std::array step_pitch_finders{semantic("CSubtickMoveStep field 8", &step_pitch)};
constexpr std::array step_yaw_finders{semantic("CSubtickMoveStep field 9", &step_yaw)};
constexpr std::array buttons_held_finders{semantic("CInButtonStatePB field 1", &buttons_held)};
constexpr std::array buttons_changed_finders{
    semantic("CInButtonStatePB field 2", &buttons_changed),
};
constexpr std::array buttons_scroll_finders{semantic("CInButtonStatePB field 3", &buttons_scroll)};
constexpr std::array base_buttons_finders{semantic("CBaseUserCmdPB field 3", &base_buttons)};
constexpr std::array base_mouse_dx_finders{semantic("CBaseUserCmdPB field 11", &base_mouse_dx)};
constexpr std::array base_mouse_dy_finders{semantic("CBaseUserCmdPB field 12", &base_mouse_dy)};
constexpr std::array base_steps_finders{
    semantic("CBaseUserCmdPB's parse of field 18", &steps_by_parse),
    shape("the builder's step adds", &steps_by_builder),
};
constexpr std::array step_new_finders{
    semantic("CBaseUserCmdPB's parse of field 18", &new_by_parse),
    shape("the builder's step adds", &new_by_builder),
};
constexpr std::array repeated_add_finders{
    semantic("CBaseUserCmdPB's parse of field 18", &add_by_parse),
    shape("the builder's step adds", &add_by_builder),
};
constexpr std::array step_rep_list_finders{
    semantic("CBaseUserCmdPB's parse of field 18", &rep_list_by_parse),
};
constexpr std::array user_cmd_base_finders{
    shape("the builder's word tests", &base_by_builder),
    shape("the base CreateMove's angle read", &base_by_create_move),
};
constexpr std::array user_cmd_buttons_finders{
    shape("the builder's word tests", &words_by_tests),
    shape("the builder's word copy", &words_by_copy),
};

constexpr auto field(std::string_view fact, std::span<const probe::finder> finders) -> fact_search {
    return fact_search{
        .fact = fact,
        .kind = kit::fact_kind::field,
        .module = cs2::client_module,
        .finders = finders,
    };
}

constexpr auto method(std::string_view fact, std::span<const probe::finder> finders)
    -> fact_search {
    return fact_search{
        .fact = fact,
        .kind = kit::fact_kind::method,
        .module = cs2::client_module,
        .finders = finders,
    };
}

constexpr std::array searches{
    field("step_has_bits", step_has_bits_finders),
    field("buttons_has_bits", buttons_has_bits_finders),
    field("base_has_bits", base_has_bits_finders),
    field("step_button", step_button_finders),
    field("step_pressed", step_pressed_finders),
    field("step_when", step_when_finders),
    field("step_forward", step_forward_finders),
    field("step_left", step_left_finders),
    field("step_pitch", step_pitch_finders),
    field("step_yaw", step_yaw_finders),
    field("buttons_held", buttons_held_finders),
    field("buttons_changed", buttons_changed_finders),
    field("buttons_scroll", buttons_scroll_finders),
    field("base_buttons", base_buttons_finders),
    field("base_mouse_dx", base_mouse_dx_finders),
    field("base_mouse_dy", base_mouse_dy_finders),
    field("base_steps", base_steps_finders),
    field("step_rep_list", step_rep_list_finders),
    method("subtick_step_new", step_new_finders),
    method("repeated_add", repeated_add_finders),
    field("user_cmd_base", user_cmd_base_finders),
    field("user_cmd_buttons", user_cmd_buttons_finders),
};

}

auto command_searches() -> std::span<const fact_search> {
    return searches;
}

}
