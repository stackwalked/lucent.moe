#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/probe/navigation.hpp>
#include <lucent/probe/strings.hpp>

#include "classes.hpp"
#include "code.hpp"
#include "searches.hpp"

// Every finder here was written against one build and checked on it by the generator:
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9, Steam build
// 26772654, 2026-11-18)
namespace lucent::finder {
namespace {

constexpr std::string_view input_class = "CCSGOInput";
constexpr std::string_view client_class = "CSource2Client";

auto input_vtable_by_rtti(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const std::optional<u32> vtable = primary_vtable(module, input_class);
    return vtable ? probe::finding{*vtable} : std::unexpected(probe::miss::none);
}

auto client_vtable_by_rtti(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const std::optional<u32> vtable = primary_vtable(module, client_class);
    return vtable ? probe::finding{*vtable} : std::unexpected(probe::miss::none);
}

// FrameStageNotify switches over the stages and names one profiler scope per network update,
// "FrameNetUpdate(%.3f %d)".
// found: client+0xb63350, CSource2Client slot 36, the only function naming that string
// breaks: the scope renamed or moved out of it: none
auto frame_stage_by_its_scope(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    std::vector<u32> starts;
    for (const u32 name : probe::string_rvas(module, "FrameNetUpdate(%.3f %d)")) {
        for (const pe::runtime_function& user : probe::functions_referencing(module, index, name)) {
            starts.push_back(function_start(module, user));
        }
    }
    return probe::one(starts);
}

auto frame_stage_slot(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    const probe::finding method = frame_stage_by_its_scope(module, index);
    if (!method) {
        return std::unexpected(method.error());
    }
    return slot_index(module, client_class, static_cast<u32>(*method));
}

// CreateMove calls the base CreateMove, then resets the input's per-tick state: a byte, a qword
// of -1, two dwords zeroed and one of -1.
// found: CCSGOInput slot 8 (client+0xce1d00) on this build; old lucent's byte pattern for it
// breaks: shape only; the reset reordered or moved into the base: none
constexpr probe::instruction_pattern resets_tick{
    "push rbx; sub rsp, 0x20; mov rbx, rcx; call ?; xor eax, eax; mov [rbx+?], 0; "
    "mov [rbx+?], -1"
};

auto create_move_by_reset(const probe::module_file& module) -> probe::finding {
    std::vector<u32> starts;
    for (const pe::runtime_function& slot : slot_functions(module, input_class)) {
        const pe::rva_range code{.rva = slot.begin, .size = slot.end - slot.begin};
        for (const probe::pattern_match& found : probe::matches_in(module, code, resets_tick)) {
            if (found.rva == slot.begin) {
                starts.push_back(slot.begin);
            }
        }
    }
    return probe::one(starts);
}

// The base CreateMove takes the slot's controller, its newest sequence, and the command at it:
// the controller handed to both, the sequence to the second.
// found: client+0xb625d0, called by CCSGOInput slot 8: GetLocalPlayerController(slot), then
// +0x93d700(controller) and +0x9404b0(controller, sequence)
// breaks: shape only; the calls reordered or inlined: none
constexpr probe::instruction_pattern takes_newest_command{
    "call ?; mov %controller, rax; test rax, rax; jz ?; mov rcx, rax; call $sequence; "
    "mov edx, eax; mov rcx, %controller; call $command"
};

// The functions the input's slots call that take the newest command.
auto command_takers(const probe::module_file& module) -> std::vector<pe::runtime_function> {
    std::vector<pe::runtime_function> takers;
    for (const pe::runtime_function& callee :
        callees_of(module, slot_functions(module, input_class))) {
        const pe::rva_range code{.rva = callee.begin, .size = callee.end - callee.begin};
        if (!probe::matches_in(module, code, takes_newest_command).empty()) {
            takers.push_back(callee);
        }
    }
    return takers;
}

// The input slot that calls the base CreateMove.
auto create_move_by_its_base(const probe::module_file& module) -> probe::finding {
    const std::vector<pe::runtime_function> takers = command_takers(module);
    std::vector<u32> starts;
    for (const pe::runtime_function& slot : slot_functions(module, input_class)) {
        for (const pe::runtime_function& callee : callees_of(module, std::span{&slot, 1})) {
            if (std::ranges::contains(takers, callee.begin, &pe::runtime_function::begin)) {
                starts.push_back(slot.begin);
            }
        }
    }
    return probe::one(starts);
}

auto create_move_reset(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return create_move_by_reset(module);
}

auto create_move_base(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return create_move_by_its_base(module);
}

auto create_move_slot_by_reset(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const probe::finding method = create_move_by_reset(module);
    return method ? slot_index(module, input_class, static_cast<u32>(*method)) : method;
}

auto create_move_slot_by_base(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const probe::finding method = create_move_by_its_base(module);
    return method ? slot_index(module, input_class, static_cast<u32>(*method)) : method;
}

auto sequence_by_base(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(captured_in(
        module,
        command_takers(module),
        takes_newest_command,
        takes_newest_command.capture("sequence")
    ));
}

auto command_by_base(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(captured_in(
        module,
        command_takers(module),
        takes_newest_command,
        takes_newest_command.capture("command")
    ));
}

// GetUserCmd: the controller's ring of 150 commands of 0x98 bytes, the slot holding the sequence
// only while its own sequence (+8) matches.
// found: client+0x9404b0, 15 callers; +0x93d700 reads the newest sequence off the same ring
// getter (+0x940540)
// breaks: shape only; the ring resized is still matched, the check changed is none
constexpr probe::instruction_pattern looks_up_command{
    "push rbx; sub rsp, 0x20; mov ebx, edx; call $ring; mov r8, rax; test ebx, ebx; jnle ?; "
    "...; imul rax, rax, ?; add rax, r8; cmp [rax+8], ebx; cmovnz rax, rcx"
};

constexpr probe::instruction_pattern reads_newest_sequence{
    "sub rsp, 0x28; call $ring; mov eax, [rax+?]; add rsp, 0x28; ret"
};

auto command_by_ring(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    std::vector<u32> starts;
    for (const probe::pattern_match& found : probe::matches_in_code(module, looks_up_command)) {
        starts.push_back(found.rva);
    }
    return probe::one(starts);
}

// The function reading the newest sequence off the ring GetUserCmd looks commands up in.
auto sequence_by_ring(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const probe::finding ring = probe::one(
        probe::captured(
            probe::matches_in_code(module, looks_up_command), looks_up_command.capture("ring")
        )
    );
    if (!ring) {
        return std::unexpected(ring.error());
    }
    std::vector<u32> starts;
    for (const probe::pattern_match& found :
        probe::matches_in_code(module, reads_newest_sequence)) {
        if (found.captures.at(static_cast<usize>(reads_newest_sequence.capture("ring"))) == *ring) {
            starts.push_back(found.rva);
        }
    }
    return probe::one(starts);
}

// The input's slot lookups load the global into r8 before scaling the slot.
// found: old lucent's byte pattern for the input global (4C 8B 05 ?? ?? ?? ?? 48 69 D1)
// breaks: shape only; the lookup rewritten: none
constexpr probe::instruction_pattern scales_slot{"mov r8, [rip+$global]; imul rdx, rcx, ?"};

auto input_by_lookup(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(probe::matches_in_code(module, scales_slot), scales_slot.capture("global"))
    );
}

// The input's view angle setter, a leaf: for slot 0, into the last pending sample's angles while
// there are samples, else into the resting angles.
// found: client+0xb76e40 (old lucent's input_set_view_angles); the getter (+0xb66ef0) reads the
// same places
// breaks: shape only; reshaped: none
constexpr probe::instruction_pattern sets_angles{
    "test edx, edx; jnz ?; movsxd rax, [rcx+$count]; movsd xmm0, [r8]; test eax, eax; jz ?; "
    "imul rdx, rax, $size; add rdx, [rcx+$samples]; movsd [rdx+$back], xmm0; mov eax, [r8+8]; "
    "mov [rdx+?], eax; ret; movsd [rcx+$resting], xmm0"
};

constexpr probe::instruction_pattern gets_angles{
    "mov r8, rcx; test edx, edx; jz ?; lea rax, [rip+?]; ret; mov eax, [rcx+$count]; "
    "test eax, eax; jz ?; dec eax; movsxd rcx, eax; mov rax, [r8+$samples]; "
    "imul rdx, rcx, $size; add rax, $angles; add rax, rdx; ret; lea rax, [rcx+$resting]"
};

auto by_setter(const probe::module_file& module, isize capture) -> probe::finding {
    return probe::one(probe::captured(probe::matches_in_code(module, sets_angles), capture));
}

auto by_getter(const probe::module_file& module, isize capture) -> probe::finding {
    return probe::one(probe::captured(probe::matches_in_code(module, gets_angles), capture));
}

// The view angle getter's callers hand it the input object, loaded from its global into rcx.
// found: the getter (client+0xb66ef0) has twenty-odd callers, each loading client+0x2230210
// before the call; CSource2Client's slot 16 thunk loads it too, but another thunk jumps through
// the same slot of another object
// breaks: the getter not found, or a caller passing another object: none or ambiguous
// The load is the call's last or second-to-last instruction before it.
constexpr probe::instruction_pattern passes_input_last{"mov rcx, [rip+$global]; call $called"};
constexpr probe::instruction_pattern passes_input{"mov rcx, [rip+$global]; ?; call $called"};
static_assert(
    passes_input_last.capture("global") == passes_input.capture("global")
    && passes_input_last.capture("called") == passes_input.capture("called")
);

auto input_by_getter_calls(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    const std::vector<probe::pattern_match> getters = probe::matches_in_code(module, gets_angles);
    if (getters.size() != 1) {
        return std::unexpected(getters.empty() ? probe::miss::none : probe::miss::ambiguous);
    }
    const u32 getter = getters.front().rva;
    std::vector<u64> globals;
    for (const pe::runtime_function& caller : probe::functions_referencing(module, index, getter)) {
        const pe::rva_range code{.rva = caller.begin, .size = caller.end - caller.begin};
        std::vector<probe::pattern_match> calls = probe::matches_in(module, code, passes_input);
        calls.append_range(probe::matches_in(module, code, passes_input_last));
        for (const probe::pattern_match& found : calls) {
            if (found.captures.at(static_cast<usize>(passes_input.capture("called"))) == getter) {
                globals.push_back(
                    found.captures.at(static_cast<usize>(passes_input.capture("global")))
                );
            }
        }
    }
    return probe::one(globals);
}

auto count_by_setter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_setter(module, sets_angles.capture("count"));
}

auto count_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_getter(module, gets_angles.capture("count"));
}

auto samples_by_setter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_setter(module, sets_angles.capture("samples"));
}

auto samples_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_getter(module, gets_angles.capture("samples"));
}

auto size_by_setter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_setter(module, sets_angles.capture("size"));
}

auto size_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_getter(module, gets_angles.capture("size"));
}

auto resting_by_setter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_setter(module, sets_angles.capture("resting"));
}

auto resting_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_getter(module, gets_angles.capture("resting"));
}

// The setter writes the angles at the end of the sample less 0x10: the sample's angles are its
// size less that.
auto sample_angles_by_setter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    const probe::finding size = by_setter(module, sets_angles.capture("size"));
    const probe::finding back = by_setter(module, sets_angles.capture("back"));
    if (!size || !back) {
        return !size ? size : back;
    }
    return *size + *back;
}

auto sample_angles_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return by_getter(module, gets_angles.capture("angles"));
}

// The mouse conversion is the one function reading both sensitivity and m_yaw. Each convar is the
// static object its registration hands the name to: `lea rdx, [rip+name]; ...; lea rcx,
// [rip+convar]`.
// found: client+0xb9ceb0 reads sensitivity (+0x25546c0), sensitivity_y_scale, m_pitch and m_yaw
// (+0x25546e0); their registrations at +0xd7e50 and +0xd7080; the other readers of either read
// one of them only
// breaks: the conversion split or the convars renamed: none
constexpr probe::instruction_pattern registers_convar{
    "lea rdx, [rip+$name]; ...; lea rcx, [rip+$convar]"
};

// Whether the data at rva is the name, NUL-terminated.
auto is_named(const probe::module_file& module, u64 rva, std::string_view name) -> bool {
    const std::optional<std::span<const std::byte>> held = module.bytes_at({
        .rva = static_cast<u32>(rva),
        .size = static_cast<u32>(name.size() + 1),
    });
    if (!held) {
        return false;
    }
    std::string stored{name};
    stored.push_back('\0');
    return std::ranges::equal(*held, std::as_bytes(std::span{stored}));
}

// The convar every registration naming it hands its name to. Read off the name's bytes rather
// than found through probe::string_rvas, which a dev build's span checks stop on a second hit in
// one section (libs/probe, reported).
auto convar_named(
    std::span<const probe::pattern_match> registrations,
    const probe::module_file& module,
    std::string_view name
) -> probe::finding {
    std::vector<u64> convars;
    for (const probe::pattern_match& found : registrations) {
        const u64 text = found.captures.at(static_cast<usize>(registers_convar.capture("name")));
        if (is_named(module, text, name)) {
            convars.push_back(
                found.captures.at(static_cast<usize>(registers_convar.capture("convar")))
            );
        }
    }
    return probe::one(convars);
}

auto mouse_turn_by_convars(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    const std::vector<probe::pattern_match> registrations =
        probe::matches_in_code(module, registers_convar);
    const probe::finding sensitivity = convar_named(registrations, module, "sensitivity");
    const probe::finding yaw = convar_named(registrations, module, "m_yaw");
    if (!sensitivity || !yaw) {
        return !sensitivity ? sensitivity : yaw;
    }
    const std::vector<pe::runtime_function> by_yaw =
        probe::functions_referencing(module, index, static_cast<u32>(*yaw));
    std::vector<u32> starts;
    for (const pe::runtime_function& reader :
        probe::functions_referencing(module, index, static_cast<u32>(*sensitivity))) {
        if (std::ranges::contains(by_yaw, reader.begin, &pe::runtime_function::begin)) {
            starts.push_back(reader.begin);
        }
    }
    // The registrations name one convar each, so they're never both.
    return probe::one(starts);
}

constexpr std::array input_vtable_finders{
    probe::finder{
        .name = "CCSGOInput's RTTI",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &input_vtable_by_rtti,
    },
};

constexpr std::array client_vtable_finders{
    probe::finder{
        .name = "CSource2Client's RTTI",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &client_vtable_by_rtti,
    },
};

constexpr std::array frame_stage_finders{
    probe::finder{
        .name = "the function naming \"FrameNetUpdate(%.3f %d)\"",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &frame_stage_by_its_scope,
    },
};

constexpr std::array frame_stage_slot_finders{
    probe::finder{
        .name = "that function's slot in CSource2Client's vtable",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &frame_stage_slot,
    },
};

constexpr std::array create_move_finders{
    probe::finder{
        .name = "the input slot resetting its tick state after the base",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &create_move_reset,
    },
    probe::finder{
        .name = "the input slot calling the function that takes the newest command",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &create_move_base,
    },
};

constexpr std::array create_move_slot_finders{
    probe::finder{
        .name = "the resetting slot's index",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &create_move_slot_by_reset,
    },
    probe::finder{
        .name = "the newest command's caller's index",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &create_move_slot_by_base,
    },
};

constexpr std::array sequence_finders{
    probe::finder{
        .name = "the base CreateMove's sequence call",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &sequence_by_base,
    },
    probe::finder{
        .name = "the newest sequence read off GetUserCmd's ring",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &sequence_by_ring,
    },
};

constexpr std::array command_finders{
    probe::finder{
        .name = "the base CreateMove's command call",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &command_by_base,
    },
    probe::finder{
        .name = "the ring lookup checking the slot's sequence",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &command_by_ring,
    },
};

constexpr std::array input_finders{
    probe::finder{
        .name = "the view angle getter's callers",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &input_by_getter_calls,
    },
    probe::finder{
        .name = "the slot lookups scaling off the global",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &input_by_lookup,
    },
};

constexpr std::array sample_count_finders{
    probe::finder{
        .name = "the view angle setter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &count_by_setter,
    },
    probe::finder{
        .name = "the view angle getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &count_by_getter,
    },
};

constexpr std::array samples_finders{
    probe::finder{
        .name = "the view angle setter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &samples_by_setter,
    },
    probe::finder{
        .name = "the view angle getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &samples_by_getter,
    },
};

constexpr std::array sample_size_finders{
    probe::finder{
        .name = "the view angle setter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &size_by_setter,
    },
    probe::finder{
        .name = "the view angle getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &size_by_getter,
    },
};

constexpr std::array sample_angles_finders{
    probe::finder{
        .name = "the view angle setter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &sample_angles_by_setter,
    },
    probe::finder{
        .name = "the view angle getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &sample_angles_by_getter,
    },
};

constexpr std::array resting_finders{
    probe::finder{
        .name = "the view angle setter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &resting_by_setter,
    },
    probe::finder{
        .name = "the view angle getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &resting_by_getter,
    },
};

constexpr std::array mouse_turn_finders{
    probe::finder{
        .name = "the one reader of both sensitivity and m_yaw",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &mouse_turn_by_convars,
    },
};

constexpr auto search(
    std::string_view fact, kit::fact_kind kind, std::span<const probe::finder> finders
) -> fact_search {
    return fact_search{
        .fact = fact,
        .kind = kind,
        .module = cs2::client_module,
        .finders = finders,
    };
}

constexpr std::array searches{
    search("input_vtable", kit::fact_kind::vtable, input_vtable_finders),
    search("client_vtable", kit::fact_kind::vtable, client_vtable_finders),
    search("frame_stage_notify", kit::fact_kind::method, frame_stage_finders),
    search("frame_stage_notify_slot", kit::fact_kind::slot, frame_stage_slot_finders),
    search("input_create_move", kit::fact_kind::method, create_move_finders),
    search("input_create_move_slot", kit::fact_kind::slot, create_move_slot_finders),
    search("controller_command_sequence", kit::fact_kind::method, sequence_finders),
    search("controller_user_command", kit::fact_kind::method, command_finders),
    search("input", kit::fact_kind::global, input_finders),
    search("input_sample_count", kit::fact_kind::field, sample_count_finders),
    search("input_samples", kit::fact_kind::field, samples_finders),
    search("input_sample_size", kit::fact_kind::value, sample_size_finders),
    search("input_sample_angles", kit::fact_kind::field, sample_angles_finders),
    search("input_view_angles", kit::fact_kind::field, resting_finders),
    search("mouse_turn", kit::fact_kind::method, mouse_turn_finders),
};

}

auto input_searches() -> std::span<const fact_search> {
    return searches;
}

}
