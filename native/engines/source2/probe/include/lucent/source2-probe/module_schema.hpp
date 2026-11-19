#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::source2 {

struct declared_base {
    std::string name;
    i32 offset = 0;

    auto operator==(const declared_base&) const -> bool = default;
};

struct declared_field {
    std::string name;
    i32 offset = 0;
    // As SchemaSystem names it: "int32", "CHandle< C_BaseEntity >", "char[128]". Absent when the
    // code that builds the type couldn't be followed.
    std::optional<std::string> type;

    auto operator==(const declared_field&) const -> bool = default;
};

struct declared_class {
    std::string name;
    // The schema project that registers it: "client", "entity2".
    std::string project;
    i32 size = 0;
    std::vector<declared_base> bases;
    std::vector<declared_field> fields;

    auto operator==(const declared_class&) const -> bool = default;
};

// The classes a module registers with SchemaSystem, read from its file without running it.
struct module_schema {
    std::vector<declared_class> classes;
    // Class records listed for registration that didn't hold together (a name that isn't text, a
    // field outside the class): left out of classes.
    isize rejected = 0;
};

auto read_schema(const probe::module_file& module, const probe::code_index& index)
    -> result<module_schema>;

// Every class of that name; a module may register a name in more than one project.
auto classes_named(const module_schema& schema, std::string_view name)
    -> std::vector<const declared_class*>;

}
