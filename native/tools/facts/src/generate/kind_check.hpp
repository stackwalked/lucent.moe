#pragma once

#include <optional>
#include <string_view>

#include <lucent/kit/fact.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::facts {

// Why a found value can't be its fact's: the generator's half of the per-kind checks, run on the
// whole image before anything is signed. The module repeats them against the loaded image.
enum class kind_flaw : u8 {
    outside_image,
    // A method not at a .pdata function start.
    not_a_function_start,
    // A global or vtable in code, or a vtable in writable data.
    wrong_section,
    misaligned,
    // A vtable whose first entry isn't code.
    not_a_vtable,
    out_of_range,
};

auto kind_flaw_of(const probe::module_file& module, const kit::fact_record& record, u64 value)
    -> std::optional<kind_flaw>;

auto describe(kind_flaw flaw) -> std::string_view;

}
