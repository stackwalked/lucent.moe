#include <array>
#include <span>
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
#include <lucent/probe/rtti.hpp>
#include <lucent/probe/strings.hpp>

#include "code.hpp"
#include "searches.hpp"

// Every finder here was written against one build and checked on it by the generator:
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9, Steam build
// 26772654, 2026-11-18)
namespace lucent::finder {
namespace {

// The function that makes the entity system copies the tier's g_pEntitySystem into client.dll's
// own global right after registering the system as "client_entities".
// found: the only code naming "client_entities" (client+0xa12cd0) news a 0x2180-byte object, runs
// CGameEntitySystem's constructor on it (the only caller of the function installing its RTTI
// vtable), hands it to the registration call with the name, then `mov rbx, [rip+...]; mov
// [rip+...], rbx`; its shutdown twin zeroes the same global
// breaks: no store, or another store of a loaded global, in that function: none or ambiguous
constexpr probe::instruction_pattern copies_system{
    "mov %system, [rip+?]; mov [rip+$global], %system"
};

auto stored_system(const probe::module_file& module, std::span<const pe::runtime_function> makers)
    -> probe::finding {
    return probe::one(captured_in(module, makers, copies_system, copies_system.capture("global")));
}

auto system_by_its_name(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    std::vector<pe::runtime_function> makers;
    for (const u32 name : probe::string_rvas(module, "client_entities")) {
        makers.append_range(probe::functions_referencing(module, index, name));
    }
    return stored_system(module, makers);
}

auto system_by_its_class(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    std::vector<pe::runtime_function> makers;
    for (const probe::rtti_vtable& vtable : probe::rtti_vtables_of(module, "CGameEntitySystem")) {
        for (const pe::runtime_function& installer :
            probe::functions_referencing(module, index, vtable.rva)) {
            makers.append_range(probe::callers_of(module, index, installer.begin));
        }
    }
    return stored_system(module, makers);
}

constexpr std::array entity_system_finders{
    probe::finder{
        .name = "the store after registering \"client_entities\"",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &system_by_its_name,
    },
    probe::finder{
        .name = "the store after CGameEntitySystem's constructor's caller makes it",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &system_by_its_class,
    },
};

// A controller being torn down takes itself out of the local controllers, an array indexed by
// split-screen slot: `cmp this, [table+slot*8]; jne; mov [table+slot*8], 0`.
// found: CBasePlayerController's vtable slot 14 (client+0x967740) walks slots 0..1 that way after
// releasing its pawn; GetLocalPlayerController (client+0x966770, 107 callers) reads the same table
// breaks: no slot of the class matching (renamed class, other teardown): none; two tables cleared
// that way: ambiguous
constexpr probe::instruction_pattern forgets_controller{
    "lea %table, [rip+$controllers]; ...; cmp ?, [%table+%slot*8]; jnz ?; mov [%table+%slot*8], ?"
};

auto controller_teardowns(const probe::module_file& module) -> std::vector<pe::runtime_function> {
    std::vector<pe::runtime_function> teardowns;
    for (const probe::rtti_vtable& vtable :
        probe::rtti_vtables_of(module, "CBasePlayerController")) {
        if (vtable.subobject_offset != 0) {
            continue;
        }
        for (const pe::runtime_function& slot :
            functions_at(module, probe::vtable_functions(module, vtable.rva))) {
            const pe::rva_range code{.rva = slot.begin, .size = slot.end - slot.begin};
            if (!probe::matches_in(module, code, forgets_controller).empty()) {
                teardowns.push_back(slot);
            }
        }
    }
    return teardowns;
}

auto controllers_by_teardown(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(captured_in(
        module,
        controller_teardowns(module),
        forgets_controller,
        forgets_controller.capture("controllers")
    ));
}

// The local pawn getter: -1 asks the engine for the active split-screen slot, the slot indexes the
// table, and the controller's pawn handle is read and tested for -1.
// found: client+0x9667b0 on this build. GetLocalPlayerController (+0x966770) reads the same table
// with the same prologue but stops there, as does a getter of another per-slot table
// (+0xce4e40, table +0x256e008), so the handle read is what tells them apart
// breaks: shape only; the getter changes its prologue or stops testing the handle: none
constexpr probe::instruction_pattern reads_controller_of_slot{
    "cmp ecx, -1; jnz ?; mov rcx, [rip+?]; lea rdx, [rsp+?]; mov rax, [rcx]; call [rax+?]; "
    "mov ecx, [rax]; movsxd rax, ecx; lea %table, [rip+$controllers]; ...; "
    "mov %entry, [%table+rax*8]; test %entry, %entry; jz ?; mov %handle, [%entry+?]; "
    "cmp %handle, -1"
};

auto controllers_by_getter(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(
            probe::matches_in_code(module, reads_controller_of_slot),
            reads_controller_of_slot.capture("controllers")
        )
    );
}

constexpr std::array local_player_controller_finders{
    probe::finder{
        .name = "CBasePlayerController's teardown slot",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &controllers_by_teardown,
    },
    probe::finder{
        .name = "the local pawn getter",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &controllers_by_getter,
    },
};

// An entity handle's low 15 bits index the identities: bits 9 and up pick a chunk, the low 9 an
// identity in it, scaled by the identity's size. Every handle lookup inlines it.
// found: 2645 `and reg, 0x1ff` followed by `imul _, reg, 0x70` on this build, all agreeing
// breaks: a chunk of other than 512 identities: none; an unrelated `and 0x1ff` scaled by another
// size nearby: ambiguous
constexpr probe::instruction_pattern scales_identity{
    "and %index, 0x1ff; ...; imul ?, %index, $size"
};

auto identity_size_by_consensus(
    const probe::module_file& module, const probe::code_index& /*index*/
) -> probe::finding {
    return probe::one(
        probe::captured(
            probe::matches_in_code(module, scales_identity), scales_identity.capture("size")
        )
    );
}

// found: the controller teardown resolves its pawn handle twice, both scaled by 0x70
// breaks: as forgets_controller's, or the teardown stops resolving handles: none
auto identity_size_by_teardown(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(captured_in(
        module, controller_teardowns(module), scales_identity, scales_identity.capture("size")
    ));
}

constexpr std::array entity_identity_size_finders{
    probe::finder{
        .name = "every handle lookup's chunk scale",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &identity_size_by_consensus,
    },
    probe::finder{
        .name = "the controller teardown's pawn lookups",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &identity_size_by_teardown,
    },
};

constexpr std::array searches{
    fact_search{
        .fact = "entity_system",
        .kind = kit::fact_kind::global,
        .module = cs2::client_module,
        .finders = entity_system_finders,
    },
    fact_search{
        .fact = "local_player_controller",
        .kind = kit::fact_kind::global,
        .module = cs2::client_module,
        .finders = local_player_controller_finders,
    },
    fact_search{
        .fact = "entity_identity_size",
        .kind = kit::fact_kind::value,
        .module = cs2::client_module,
        .finders = entity_identity_size_finders,
    },
};

}

auto entity_searches() -> std::span<const fact_search> {
    return searches;
}

}
