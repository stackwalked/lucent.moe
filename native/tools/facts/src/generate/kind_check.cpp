#include "generate/kind_check.hpp"

#include <algorithm>
#include <optional>
#include <string_view>

#include <lucent/kit/fact.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::facts {
namespace {

constexpr u64 pointer_alignment = 8;

auto section_of(const probe::module_file& module, u64 rva) -> std::optional<pe::section> {
    for (const pe::section& stored : module.view().sections()) {
        if (rva >= stored.virtual_address
            && rva - stored.virtual_address < pe::mapped_size_of(stored)) {
            return stored;
        }
    }
    return std::nullopt;
}

auto is_aligned(u64 value, u64 alignment) -> bool {
    return alignment == 0 || value % alignment == 0;
}

auto method_flaw(const probe::module_file& module, u32 rva) -> std::optional<kind_flaw> {
    const bool is_start =
        std::ranges::binary_search(module.functions(), rva, {}, &pe::runtime_function::begin);
    return is_start ? std::nullopt : std::optional{kind_flaw::not_a_function_start};
}

auto data_flaw(const pe::section& holder, u64 value, u64 alignment) -> std::optional<kind_flaw> {
    if (holder.access.is_executable) {
        return kind_flaw::wrong_section;
    }
    return is_aligned(value, alignment) ? std::nullopt : std::optional{kind_flaw::misaligned};
}

auto vtable_flaw(const probe::module_file& module, const pe::section& holder, u32 rva)
    -> std::optional<kind_flaw> {
    if (holder.access.is_executable || holder.access.is_writable) {
        return kind_flaw::wrong_section;
    }
    if (!is_aligned(rva, pointer_alignment)) {
        return kind_flaw::misaligned;
    }
    const std::optional<u64> first = module.u64_at(rva);
    const std::optional<u32> entry = first ? module.rva_of(*first) : std::nullopt;
    return entry && module.is_code(*entry) ? std::nullopt : std::optional{kind_flaw::not_a_vtable};
}

auto value_flaw(const kit::fact_record& record, u64 value) -> std::optional<kind_flaw> {
    const kit::value_range range = kit::unpack_range(record.bound);
    const auto number = static_cast<i64>(value);
    const bool is_inside = number >= range.min && number <= range.max;
    return is_inside ? std::nullopt : std::optional{kind_flaw::out_of_range};
}

auto address_flaw(const probe::module_file& module, const kit::fact_record& record, u64 value)
    -> std::optional<kind_flaw> {
    const std::optional<pe::section> holder = section_of(module, value);
    if (!holder) {
        return kind_flaw::outside_image;
    }
    const auto rva = static_cast<u32>(value);
    switch (record.kind) {
    case kit::fact_kind::method:
        return method_flaw(module, rva);
    case kit::fact_kind::global:
        return data_flaw(*holder, value, record.alignment);
    case kit::fact_kind::vtable:
        return vtable_flaw(module, *holder, rva);
    case kit::fact_kind::slot:
    case kit::fact_kind::field:
    case kit::fact_kind::value:
        break;
    }
    LUCENT_UNREACHABLE();
}

}

// A slot's bound (its vtable's length) and a field's owner size are facts of their own; checking
// against them waits for the first such fact.
auto kind_flaw_of(const probe::module_file& module, const kit::fact_record& record, u64 value)
    -> std::optional<kind_flaw> {
    switch (record.kind) {
    case kit::fact_kind::method:
    case kit::fact_kind::global:
    case kit::fact_kind::vtable:
        return address_flaw(module, record, value);
    case kit::fact_kind::slot:
        return std::nullopt;
    case kit::fact_kind::field:
        return is_aligned(value, record.alignment) ? std::nullopt
                                                   : std::optional{kind_flaw::misaligned};
    case kit::fact_kind::value:
        return value_flaw(record, value);
    }
    LUCENT_UNREACHABLE();
}

auto describe(kind_flaw flaw) -> std::string_view {
    switch (flaw) {
    case kind_flaw::outside_image:
        return "outside the image";
    case kind_flaw::not_a_function_start:
        return "not at a .pdata function start";
    case kind_flaw::wrong_section:
        return "in the wrong kind of section";
    case kind_flaw::misaligned:
        return "misaligned for its type";
    case kind_flaw::not_a_vtable:
        return "not a vtable: its first entry isn't code";
    case kind_flaw::out_of_range:
        return "outside its declared range";
    }
    LUCENT_UNREACHABLE();
}

}
