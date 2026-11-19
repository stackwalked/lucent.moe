#pragma once

// How a Source 2 module and SchemaSystem meet at registration, as cs2's client.dll and
// schemasystem.dll lay it out (research/kb/source2/schema-registration.md): the objects and
// vtables the module calls, and the class records it hands over. The fixture module is written
// against it the way client.dll is; the tests play SchemaSystem against the loaded fixture through
// it. Written as the target is: C types, the target's own shapes.

#include <array>
#include <cstddef>
#include <cstdint>

namespace game {

// CSchemaType, opaque to the module.
struct type;
struct type_scope;
struct schema_system;
struct class_record;

// CSchemaSystemTypeScope's vtable as far as registration calls it.
struct type_scope_methods {
    std::array<const void*, 5> unused;
    auto (*builtin)(type_scope* scope, type** made, int kind) -> type**;
    auto (*pointer)(type_scope* scope, type** made, type* pointee) -> type**;
    auto (*atomic)(type_scope* scope, type** made, const char* name, int size, char alignment)
        -> type**;
    auto (*atomic_of_type)(
        type_scope* scope, type** made, const char* name, int size, char alignment, type* argument
    ) -> type**;
    auto (*collection)(
        type_scope* scope,
        type** made,
        const char* name,
        int size,
        char alignment,
        short element_size,
        type* element,
        std::uint64_t fixed_count,
        void* manipulator
    ) -> type**;
    auto (*atomic_of_two_types)(
        type_scope* scope,
        type** made,
        const char* name,
        int size,
        char alignment,
        type* first,
        type* second
    ) -> type**;
    auto (*atomic_of_number)(
        type_scope* scope, type** made, const char* name, int size, char alignment, int number
    ) -> type**;
    auto (*declared_class)(type_scope* scope, type** made, const char* name) -> type**;
    auto (*declared_enum)(type_scope* scope, type** made, const char* name) -> type**;
    auto (*fixed_array)(
        type_scope* scope, type** made, type* element, int count, short element_size, char alignment
    ) -> type**;
    // The dimensions follow, outermost first, ending at -1. The game declares size and alignment
    // as short and char; int fills the same argument slots and can precede the variadic part.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg): the target's own signature.
    auto (*multi_array)(type_scope* scope, type** made, type* element, int size, int alignment, ...)
        -> type**;
    auto (*bitfield)(type_scope* scope, type** made, int bits) -> type**;
};

static_assert(offsetof(type_scope_methods, builtin) == 0x28);
static_assert(offsetof(type_scope_methods, bitfield) == 0x80);

struct type_scope {
    const type_scope_methods* methods;
};

using install_fn = auto (*)(
    schema_system* system,
    void* module,
    const char* project,
    type** table,
    int table_version,
    class_record* const* classes,
    void* failure
) -> bool;

// ISchemaSystem's vtable as far as registration calls it.
struct schema_system_methods {
    std::array<const void*, 12> unused_before_scope;
    auto (*find_type_scope)(schema_system* system, void* module, int flags) -> type_scope*;
    std::array<const void*, 21> unused_before_install;
    install_fn install_classes;
};

static_assert(offsetof(schema_system_methods, find_type_scope) == 0x60);
static_assert(offsetof(schema_system_methods, install_classes) == 0x110);

struct schema_system {
    const schema_system_methods* methods;
};

// A field's type before registration: null for its class's callback to build, or a tag naming a
// slot of the project's type table.
constexpr std::uint64_t table_tag = 0xf000'0000'0000'0000;

// SchemaClassFieldData_t.
struct field_record {
    const char* name;
    std::uint64_t type;
    std::int32_t offset;
    std::int32_t metadata_count;
    const void* metadata;
};

static_assert(sizeof(field_record) == 0x20);

// SchemaBaseClassInfoData_t.
struct base_record {
    std::uint32_t offset;
    const class_record* owner;
};

static_assert(sizeof(base_record) == 0x10);

// Runs per registration phase: 0 builds the types the table doesn't hold, 1 links bases from
// elsewhere.
using class_callback = auto (*)(int phase, class_record* record) -> void*;

// SchemaClassInfoData_t as the module stores it before registration.
struct class_record {
    const void* self;
    const char* name;
    const char* module;
    std::uint64_t unknown_18;
    std::int32_t size;
    std::int16_t field_count;
    std::int16_t static_field_count;
    std::uint8_t alignment;
    std::uint8_t base_count;
    std::array<std::uint8_t, 6> unknown_2a;
    field_record* fields;
    base_record* bases;
    std::array<const void*, 2> unknown_40;
    type_scope* scope;
    const void* unknown_58;
    std::uint64_t flags;
    class_callback callback;
    std::array<const void*, 2> unknown_70;
};

static_assert(offsetof(class_record, size) == 0x20);
static_assert(offsetof(class_record, base_count) == 0x29);
static_assert(offsetof(class_record, fields) == 0x30);
static_assert(offsetof(class_record, scope) == 0x50);
static_assert(offsetof(class_record, callback) == 0x68);
static_assert(sizeof(class_record) == 0x80);

}
