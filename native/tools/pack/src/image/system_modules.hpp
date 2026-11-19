#pragma once

#include <filesystem>
#include <flat_map>
#include <string>
#include <string_view>

#include "image/refusal.hpp"

namespace lucent::pack {

// This machine's modules, mapped without running them, to check each import the way the loader
// will resolve it: by the file the OS loader picks for the import's module name (API sets resolve
// to their host), which must sit in System32, and by an exported name, following forwarders.
// Unmapped when this is destroyed.
class system_modules final {
public:
    system_modules() = default;
    system_modules(const system_modules&) = delete ("each module is mapped once and freed once");
    auto operator=(const system_modules&) -> system_modules& = delete ("as above");
    system_modules(system_modules&&) = delete ("as above");
    auto operator=(system_modules&&) -> system_modules& = delete ("as above");
    ~system_modules();

    // The module's file name in lowercase: the name the container hashes.
    auto resolve_module(std::string_view name) -> pack_result<std::string>;

    // Fails unless the export, followed through forwarders, ends in code or data.
    auto check_export(std::string_view module, std::string_view function) -> pack_result<void>;

private:
    struct mapped_module {
        void* handle = nullptr;
        std::filesystem::path path;
    };

    auto map(std::string_view name) -> pack_result<mapped_module>;

    std::flat_map<std::string, mapped_module> m_by_name;
};

}
