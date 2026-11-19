#pragma once

#include <array>
#include <flat_map>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::source2::detail {

// The SchemaSystem objects registration code calls into: ISchemaSystem, handed to
// InstallSchemaBindings, and the CSchemaSystemTypeScope it returns for a module.
enum class object_kind : u8 { schema_system, type_scope };

struct unknown_value {
    auto operator==(const unknown_value&) const -> bool = default;
};

struct number_value {
    u64 bits = 0;

    auto operator==(const number_value&) const -> bool = default;
};

// An address on the emulated stack, as an offset from rsp at entry.
struct stack_value {
    i64 offset = 0;

    auto operator==(const stack_value&) const -> bool = default;
};

// A CSchemaType the type scope made, as an index into the machine's type names.
struct type_value {
    isize index = 0;

    auto operator==(const type_value&) const -> bool = default;
};

struct object_value {
    object_kind kind = object_kind::schema_system;

    auto operator==(const object_value&) const -> bool = default;
};

struct vtable_value {
    object_kind kind = object_kind::schema_system;

    auto operator==(const vtable_value&) const -> bool = default;
};

// A virtual function of an object, by its offset in the vtable.
struct method_value {
    object_kind kind = object_kind::schema_system;
    i64 offset = 0;

    auto operator==(const method_value&) const -> bool = default;
};

// A number xored with a stack address: how MSVC's /GS stores its cookie, which xoring with the same
// address gives back.
struct masked_value {
    u64 bits = 0;
    i64 offset = 0;

    auto operator==(const masked_value&) const -> bool = default;
};

using value = std::variant<
    unknown_value,
    number_value,
    stack_value,
    type_value,
    object_value,
    vtable_value,
    method_value,
    masked_value>;

auto number_in(const value& held) -> std::optional<u64>;

// A call the code made: to an address in the image or to an object's method, with what it passed
// in rcx, rdx, r8 and r9 and in the stack slots after the home space ([rsp+0x20], [rsp+0x28], ...).
struct call_event {
    value target;
    std::array<value, 4> arguments;
    std::array<value, 8> stack_arguments;
};

// A store to an absolute address in the image.
struct store_event {
    u64 address = 0;
    value stored;
};

// What one run saw, over every path it took.
struct trace {
    std::vector<call_event> calls;
    std::vector<store_event> stores;
};

// Where a run starts, and what it starts with in rcx, rdx, r8 and r9. Everything else is unknown.
struct entry {
    u32 rva = 0;
    std::array<value, 4> arguments;
};

// A cell of emulated memory: what was stored, and how many bytes.
struct cell {
    value stored;
    u8 width = 8;
};

// Runs registration code on symbolic values, without the game: numbers where the code computes
// them from constants and the image, SchemaSystem's objects where it calls them. The type scope's
// constructors are modeled as SchemaSystem implements them, so a type the code builds is known by
// name. Memory the code writes in the image persists across runs, as the game's static data does
// across its registration phases.
//
// A branch on an unknown value forks at the outermost function and gives up inside a callee, which
// then counts as a call that returned something unknown. Runs are bounded in instructions and
// paths.
class machine final {
public:
    explicit machine(const probe::module_file& module);

    auto run(const probe::module_file& module, const entry& start) -> trace;
    // A run for what it writes into memory alone.
    auto settle(const probe::module_file& module, const entry& start) -> void;

    // Also how memory the game fills at run time, and registration code reads, is seeded.
    auto write(u64 address, value stored, u8 width) -> void;
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters): an address and a width, named at the call.
    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters): an address and a width, named at the call.
    auto load(const probe::module_file& module, u64 address, u8 width) const -> value;
    auto type_name(isize index) const -> std::string_view;
    auto intern(std::string name) -> type_value;

private:
    std::flat_map<u64, cell> m_memory;
    std::vector<std::string> m_type_names;
    u64 m_image_base = 0;
};

}
