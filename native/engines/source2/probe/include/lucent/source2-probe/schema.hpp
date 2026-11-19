#pragma once

#include <string_view>

#include <lucent/core/fixed_string.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::source2 {

// What a schema finder asks the module's schema for: a field and the type SchemaSystem must name
// for it ("int32", "CHandle< C_CSPlayerPawn >"), a class's size, or a base's offset.
struct field_query {
    std::string_view owner;
    std::string_view field;
    std::string_view type;
};

struct base_query {
    std::string_view owner;
    std::string_view base;
};

// The field's offset; none when the class or field is missing, or the field's type isn't the one
// asked for; ambiguous when two classes of that name both hold the field at different offsets.
auto field_offset(
    const probe::module_file& module, const probe::code_index& index, field_query asked
) -> probe::finding;
auto class_size(
    const probe::module_file& module, const probe::code_index& index, std::string_view owner
) -> probe::finding;
auto base_offset(const probe::module_file& module, const probe::code_index& index, base_query asked)
    -> probe::finding;

namespace detail {

template <fixed_string Owner, fixed_string Field, fixed_string Type>
auto run_field_offset(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    return field_offset(
        module, index, {.owner = Owner.as_view(), .field = Field.as_view(), .type = Type.as_view()}
    );
}

template <fixed_string Owner>
auto run_class_size(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    return class_size(module, index, Owner.as_view());
}

template <fixed_string Owner, fixed_string Base>
auto run_base_offset(const probe::module_file& module, const probe::code_index& index)
    -> probe::finding {
    return base_offset(module, index, {.owner = Owner.as_view(), .base = Base.as_view()});
}

}

// A schema field as a finder: `source2::schema<"C_BaseEntity", "m_iHealth", "int32">()`. The
// type is SchemaSystem's name for the declared type; a field whose schema type differs finds
// nothing, so a fact's T and the game's type can't drift apart unnoticed.
template <fixed_string Owner, fixed_string Field, fixed_string Type>
consteval auto schema() -> probe::finder {
    return probe::finder{
        .name = "the field in the schema the module registers",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &detail::run_field_offset<Owner, Field, Type>,
    };
}

// A class's size, for the size fact of a mirror with schema fields.
template <fixed_string Owner>
consteval auto schema_size() -> probe::finder {
    return probe::finder{
        .name = "the class's size in the schema the module registers",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &detail::run_class_size<Owner>,
    };
}

// Where a base class sits inside a class, for a mirror's non-zero base offset fact.
template <fixed_string Owner, fixed_string Base>
consteval auto schema_base() -> probe::finder {
    return probe::finder{
        .name = "the base's offset in the schema the module registers",
        .rests_on = probe::basis::semantic,
        .reason = "",
        .run = &detail::run_base_offset<Owner, Base>,
    };
}

}
