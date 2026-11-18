#pragma once

#include <string_view>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// A vtable MSVC's RTTI ties to a class: one per base subobject with virtual functions, placed at
// subobject_offset inside the object. The primary vtable is at offset 0.
struct rtti_vtable {
    u32 rva = 0;
    u32 subobject_offset = 0;

    auto operator==(const rtti_vtable&) const -> bool = default;
};

// The vtables of the class named as in source ("game::hud") or by its decorated type name
// (".?AVhud@game@@"), ordered by subobject offset. Empty when the module has no RTTI for it.
auto rtti_vtables_of(const module_file& module, std::string_view name) -> std::vector<rtti_vtable>;

}
