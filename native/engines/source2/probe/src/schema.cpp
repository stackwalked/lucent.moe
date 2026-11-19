#include <lucent/source2-probe/schema.hpp>

#include <expected>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/source2-probe/module_schema.hpp>

namespace lucent::source2 {
namespace {

auto missing() -> probe::finding {
    return std::unexpected(probe::miss::none);
}

}

auto field_offset(
    const probe::module_file& module, const probe::code_index& index, field_query asked
) -> probe::finding {
    const result<module_schema> schema = read_schema(module, index);
    if (!schema) {
        return missing();
    }
    std::vector<u64> offsets;
    for (const declared_class* owner : classes_named(*schema, asked.owner)) {
        for (const declared_field& field : owner->fields) {
            if (field.name == asked.field && field.type == asked.type) {
                offsets.push_back(static_cast<u64>(field.offset));
            }
        }
    }
    return probe::one(offsets);
}

auto class_size(
    const probe::module_file& module, const probe::code_index& index, std::string_view owner
) -> probe::finding {
    const result<module_schema> schema = read_schema(module, index);
    if (!schema) {
        return missing();
    }
    std::vector<u64> sizes;
    for (const declared_class* named : classes_named(*schema, owner)) {
        sizes.push_back(static_cast<u64>(named->size));
    }
    return probe::one(sizes);
}

auto base_offset(const probe::module_file& module, const probe::code_index& index, base_query asked)
    -> probe::finding {
    const result<module_schema> schema = read_schema(module, index);
    if (!schema) {
        return missing();
    }
    std::vector<u64> offsets;
    for (const declared_class* owner : classes_named(*schema, asked.owner)) {
        for (const declared_base& base : owner->bases) {
            if (base.name == asked.base) {
                offsets.push_back(static_cast<u64>(base.offset));
            }
        }
    }
    return probe::one(offsets);
}

}
