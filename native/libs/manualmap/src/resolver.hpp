#pragma once

#include <flat_map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <lucent/os/process.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/wire/container.hpp>

namespace lucent::manualmap::detail {

// What to look up in a module's exports.
using symbol = std::variant<std::string, pe::export_ordinal>;

// Modules in the target and their exports, each read at most once while one image is mapped.
// Modules the target lacks are loaded into it.
class resolver final {
public:
    // With a key, modules and exports can also be named by their container import hashes.
    resolver(const os::process& target, std::optional<wire::import_key> key);

    // The address in the target of an export, following forwarders to the module that has it.
    auto resolve(std::string_view module, symbol wanted) -> result<uptr>;

    // As resolve, with the module and the export named by their hashes: the module among those
    // loaded in the target, then among System32's files; the export among the module's names.
    // Only for a resolver made with a key.
    auto resolve_import(const wire::container_import& wanted) -> result<uptr>;

private:
    struct module_exports {
        pe::export_table table;
        std::vector<std::string> names;
    };

    auto module_base(std::string_view name) -> result<uptr>;
    auto exports_at(uptr base) -> result<const module_exports*>;
    auto module_named(u64 hash, const wire::import_key& key) -> result<std::string>;

    const os::process* m_target;
    std::optional<wire::import_key> m_key;
    std::flat_map<std::string, uptr> m_base_of_name;
    std::flat_map<uptr, module_exports> m_exports_of_base;
    // Filled on the first hashed lookup.
    std::optional<std::flat_map<u64, std::string>> m_module_of_hash;
};

}
