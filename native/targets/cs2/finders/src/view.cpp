#include <array>
#include <span>
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
#include <lucent/probe/navigation.hpp>
#include <lucent/probe/strings.hpp>

#include "code.hpp"
#include "searches.hpp"

// Every finder here was written against one build and checked on it by the generator:
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9, Steam build
// 26772654, 2026-11-18)
namespace lucent::finder {
namespace {

// view.cpp's view setup computes the view's matrices into three globals in one call: world to
// view in r8, view to projection in r9, world to projection in the first stack argument. The last
// is the view matrix.
// found: of the three functions naming the build path ...\game\client\view.cpp, client+0xc0b000
// makes the call (to client+0x3b6c00) with `lea rcx, [rip+matrix]; ...; mov [rsp+0x20], rcx; lea
// r9, [rip+...]; ...; lea r8, [rip+...]`; the indexed accessor below reads the same global
// breaks: the file renamed or the call's arguments built another way: none
constexpr probe::instruction_pattern passes_matrices{
    "lea %held, [rip+$matrix]; ...; mov [rsp+0x20], %held; lea r9, [rip+?]; ...; "
    "lea r8, [rip+?]; ...; call ?"
};

auto matrix_by_view_setup(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    std::vector<pe::runtime_function> setups;
    for (const u32 path : probe::strings_ending_with(module, R"(\game\client\view.cpp)")) {
        setups.append_range(probe::functions_referencing(module, index, path));
    }
    return probe::one(
        captured_in(module, setups, passes_matrices, passes_matrices.capture("matrix"))
    );
}

// The accessor of a split-screen slot's matrix: 64-byte rows off the global.
// found: client+0xc0a9c0, a leaf without unwind data; old lucent's byte pattern for the view
// matrix (48 8D 0D ?? ?? ?? ?? 48 C1 E0 06) landed in it
// breaks: shape only; inlined away or reshaped: none
constexpr probe::instruction_pattern indexes_matrix{
    "movsxd rax, ecx; lea rcx, [rip+$matrix]; shl rax, 6; add rax, rcx; ret"
};

auto matrix_by_accessor(const probe::module_file& module, const probe::code_index& /*index*/)
    -> probe::finding {
    return probe::one(
        probe::captured(
            probe::matches_in_code(module, indexes_matrix), indexes_matrix.capture("matrix")
        )
    );
}

constexpr std::array view_matrix_finders{
    probe::finder{
        .name = "view.cpp's matrix setup call",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &matrix_by_view_setup,
    },
    probe::finder{
        .name = "the per-slot accessor",
        .rests_on = probe::basis::shape,
        .reason = "",
        .run = &matrix_by_accessor,
    },
};

constexpr std::array searches{
    fact_search{
        .fact = "view_matrix",
        .kind = kit::fact_kind::global,
        .module = cs2::client_module,
        .finders = view_matrix_finders,
    },
};

}

auto view_searches() -> std::span<const fact_search> {
    return searches;
}

}
