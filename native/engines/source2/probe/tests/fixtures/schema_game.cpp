// A stand-in for a Source 2 game module: it registers a small schema the way cs2's client.dll
// does, for the reader to read from disk and for the tests to run against a SchemaSystem of their
// own. InstallSchemaBindings runs every registrar through four phases; registrars link themselves
// into a list from static initializers; phase 0 builds each project's type table through the type
// scope and phase 2 hands SchemaSystem the project's class records, whose callbacks build the
// remaining types and link a base from elsewhere.

#include <array>
#include <bit>
#include <cstdint>
#include <string_view>

#include "schema_layout.hpp"

// Written as the game is.
// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables): SchemaSystem writes into it.
// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic): records through their pointers.
// NOLINTBEGIN(bugprone-throwing-static-initialization): constinit data; nothing in it throws.
// NOLINTBEGIN(misc-use-internal-linkage): the registrar base is shared by both projects.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage" // records indexed as the game does

namespace game {

class registration {
public:
    virtual auto install(schema_system* system, int phase, void* failure) -> bool = 0;

    auto next() const -> registration* {
        return m_next;
    }

    // Newest first, as the game's static initializers leave them. Inlined or not per fixture
    // (CMakeLists.txt).
    [[SCHEMA_GAME_LINK]] auto link(registration*& head) -> void {
        m_next = head;
        head = this;
    }

protected:
    constexpr registration() = default;
    constexpr ~registration() = default;
    registration(const registration&) = default;
    auto operator=(const registration&) -> registration& = default;
    registration(registration&&) = default;
    auto operator=(registration&&) -> registration& = default;

private:
    registration* m_next = nullptr;
};

namespace {

constinit schema_system* installed_system = nullptr;
constinit bool is_installed = false;

constinit registration* registrations = nullptr;

constexpr auto tag(std::uint64_t slot) -> std::uint64_t {
    return table_tag | slot;
}

auto scope_of(const class_record* record) -> type_scope* {
    return record->scope;
}

auto as_field_type(type* made) -> std::uint64_t {
    return std::bit_cast<std::uint64_t>(made);
}

auto declared_class(type_scope* scope, const char* name) -> type* {
    type* made = nullptr;
    return *scope->methods->declared_class(scope, &made, name);
}

auto pointer_to(type_scope* scope, type* pointee) -> type* {
    type* made = nullptr;
    return *scope->methods->pointer(scope, &made, pointee);
}

auto builtin(type_scope* scope, int kind) -> type* {
    type* made = nullptr;
    return *scope->methods->builtin(scope, &made, kind);
}

// The "entity" project: the base every entity derives from, registered by another project.

constinit std::array<type*, 8> entity_types{};

constinit std::array entity_instance_fields{
    field_record{
        .name = "m_iszName",
        .type = tag(0),
        .offset = 0x08,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_pIdentity",
        .type = 0,
        .offset = 0x10,
        .metadata_count = 0,
        .metadata = nullptr,
    },
};

auto entity_instance_callback(int phase, class_record* record) -> void* {
    if (phase == 0) {
        type_scope* scope = scope_of(record);
        record->fields[1].type =
            as_field_type(pointer_to(scope, declared_class(scope, "CFixtureIdentity")));
    }
    return record;
}

constinit class_record entity_instance{
    .self = nullptr,
    .name = "CFixtureInstance",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x30,
    .field_count = 2,
    .static_field_count = 0,
    .alignment = 8,
    .base_count = 0,
    .unknown_2a = {},
    .fields = entity_instance_fields.data(),
    .bases = nullptr,
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = &entity_instance_callback,
    .unknown_70 = {},
};

constinit const std::array<class_record*, 2> entity_classes{&entity_instance, nullptr};

auto build_entity_types() -> void {
    type_scope* scope = installed_system->methods->find_type_scope(installed_system, nullptr, 0);
    type* made = nullptr;
    entity_types[0] = *scope->methods->atomic(scope, &made, "CUtlSymbolLarge", 8, 8);
}

class entity_registration final : public registration {
public:
    auto install(schema_system* system, int phase, void* failure) -> bool override {
        switch (phase) {
        case 0:
            build_entity_types();
            return true;
        case 2:
            return system->methods->install_classes(
                system, nullptr, "entity", entity_types.data(), 118, entity_classes.data(), failure
            );
        default:
            return true;
        }
    }
};

// The "client" project: entities, their scene nodes, and data whose base is linked late.

constinit std::array<type*, 8> client_types{};

constexpr std::uint64_t int32_slot = 0;
constexpr std::uint64_t uint8_slot = 1;
constexpr std::uint64_t vector_slot = 3;
constexpr std::uint64_t handle_slot = 4;

constinit std::array entity_fields{
    field_record{
        .name = "m_pGameSceneNode",
        .type = 0,
        .offset = 0x330,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_iHealth",
        .type = tag(int32_slot),
        .offset = 0x34c,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_hOwnerEntity",
        .type = tag(handle_slot),
        .offset = 0x364,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_iTeamNum",
        .type = tag(uint8_slot),
        .offset = 0x3e7,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_vecAbsVelocity",
        .type = tag(vector_slot),
        .offset = 0x3f8,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_bDirty",
        .type = 0,
        .offset = 0,
        .metadata_count = 0,
        .metadata = nullptr,
    },
};

constinit std::array entity_bases{base_record{.offset = 0, .owner = &entity_instance}};

auto entity_callback(int phase, class_record* record) -> void* {
    if (phase == 0) {
        type_scope* scope = scope_of(record);
        type* made = nullptr;
        record->fields[0].type =
            as_field_type(pointer_to(scope, declared_class(scope, "CFixtureSceneNode")));
        record->fields[5].type = as_field_type(*scope->methods->bitfield(scope, &made, 3));
    }
    return record;
}

constinit class_record entity{
    .self = nullptr,
    .name = "C_FixtureEntity",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x600,
    .field_count = 6,
    .static_field_count = 0,
    .alignment = 8,
    .base_count = 1,
    .unknown_2a = {},
    .fields = entity_fields.data(),
    .bases = entity_bases.data(),
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = &entity_callback,
    .unknown_70 = {},
};

constinit std::array scene_node_fields{
    field_record{
        .name = "m_boneTransforms",
        .type = 0,
        .offset = 0x10,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_children",
        .type = 0,
        .offset = 0x40,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_slots",
        .type = 0,
        .offset = 0x58,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_weights",
        .type = 0,
        .offset = 0x60,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_dirtyBones",
        .type = 0,
        .offset = 0x70,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_nodeKind",
        .type = 0,
        .offset = 0x74,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_vecAbsOrigin",
        .type = 0,
        .offset = 0xc8,
        .metadata_count = 0,
        .metadata = nullptr,
    },
};

auto scene_node_callback(int phase, class_record* record) -> void* {
    if (phase != 0) {
        return record;
    }
    type_scope* scope = scope_of(record);
    const type_scope_methods& make = *scope->methods;
    field_record* fields = record->fields;
    type* made = nullptr;
    fields[0].type =
        as_field_type(*make.multi_array(scope, &made, builtin(scope, 11), 4, 4, 3, 4, -1));
    fields[1].type = as_field_type(*make.collection(
        scope,
        &made,
        "CUtlVector",
        24,
        8,
        8,
        pointer_to(scope, declared_class(scope, "CFixtureSceneNode")),
        0,
        nullptr
    ));
    fields[2].type = as_field_type(*make.collection(
        scope, &made, "CUtlVectorFixedGrowable", 48, 8, 4, builtin(scope, 7), 8, nullptr
    ));
    fields[3].type = as_field_type(*make.atomic_of_two_types(
        scope, &made, "CUtlMap", 40, 8, builtin(scope, 7), builtin(scope, 11)
    ));
    fields[4].type = as_field_type(*make.atomic_of_number(scope, &made, "CBitVec", 4, 4, 10));
    fields[5].type = as_field_type(*make.declared_enum(scope, &made, "FixtureNodeKind_t"));
    fields[6].type = as_field_type(*make.atomic(scope, &made, "VectorWS", 12, 4));
    return record;
}

constinit class_record scene_node{
    .self = nullptr,
    .name = "CFixtureSceneNode",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x130,
    .field_count = 7,
    .static_field_count = 0,
    .alignment = 16,
    .base_count = 0,
    .unknown_2a = {},
    .fields = scene_node_fields.data(),
    .bases = nullptr,
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = &scene_node_callback,
    .unknown_70 = {},
};

constinit std::array controller_fields{
    field_record{
        .name = "m_hPawn",
        .type = 0,
        .offset = 0x6bc,
        .metadata_count = 0,
        .metadata = nullptr,
    },
    field_record{
        .name = "m_iszPlayerName",
        .type = 0,
        .offset = 0x6fc,
        .metadata_count = 0,
        .metadata = nullptr,
    },
};

constinit std::array controller_bases{base_record{.offset = 0, .owner = &entity}};

auto controller_callback(int phase, class_record* record) -> void* {
    if (phase == 0) {
        type_scope* scope = scope_of(record);
        const type_scope_methods& make = *scope->methods;
        type* made = nullptr;
        record->fields[0].type = as_field_type(*make.atomic_of_type(
            scope, &made, "CHandle", 4, 4, declared_class(scope, "C_FixturePawn")
        ));
        record->fields[1].type =
            as_field_type(*make.fixed_array(scope, &made, builtin(scope, 2), 128, 1, 1));
    }
    return record;
}

constinit class_record controller{
    .self = nullptr,
    .name = "C_FixtureController",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x800,
    .field_count = 2,
    .static_field_count = 0,
    .alignment = 8,
    .base_count = 1,
    .unknown_2a = {},
    .fields = controller_fields.data(),
    .bases = controller_bases.data(),
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = &controller_callback,
    .unknown_70 = {},
};

constinit class_record vdata_base{
    .self = nullptr,
    .name = "CFixtureVDataBase",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x10,
    .field_count = 0,
    .static_field_count = 0,
    .alignment = 8,
    .base_count = 0,
    .unknown_2a = {},
    .fields = nullptr,
    .bases = nullptr,
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = nullptr,
    .unknown_70 = {},
};

// Its base's record is filled in at registration, as the game's VData classes' are.
constinit std::array vdata_bases{base_record{.offset = 0x10, .owner = nullptr}};

constinit std::array vdata_fields{
    field_record{
        .name = "m_flRange",
        .type = tag(2),
        .offset = 0x28,
        .metadata_count = 0,
        .metadata = nullptr,
    },
};

auto vdata_callback(int phase, class_record* record) -> void* {
    if (phase == 1 && record->bases[0].owner == nullptr) {
        record->bases[0].owner = &vdata_base;
    }
    return record;
}

constinit class_record vdata{
    .self = nullptr,
    .name = "CFixtureWeaponVData",
    .module = nullptr,
    .unknown_18 = 0,
    .size = 0x40,
    .field_count = 1,
    .static_field_count = 0,
    .alignment = 8,
    .base_count = 1,
    .unknown_2a = {},
    .fields = vdata_fields.data(),
    .bases = vdata_bases.data(),
    .unknown_40 = {},
    .scope = nullptr,
    .unknown_58 = nullptr,
    .flags = 0,
    .callback = &vdata_callback,
    .unknown_70 = {},
};

constinit const std::array<class_record*, 6> client_classes{
    &entity,
    &scene_node,
    &controller,
    &vdata_base,
    &vdata,
    nullptr,
};

auto build_client_types() -> void {
    type_scope* scope = installed_system->methods->find_type_scope(installed_system, nullptr, 0);
    const type_scope_methods& make = *scope->methods;
    type* made = nullptr;
    client_types[int32_slot] = *make.builtin(scope, &made, 7);
    client_types[uint8_slot] = *make.builtin(scope, &made, 4);
    client_types[2] = *make.builtin(scope, &made, 11);
    client_types[vector_slot] = *make.atomic(scope, &made, "Vector", 12, 4);
    type* owner = *make.declared_class(scope, &made, "C_FixtureEntity");
    client_types[handle_slot] = *make.atomic_of_type(scope, &made, "CHandle", 4, 4, owner);
}

class client_registration final : public registration {
public:
    auto install(schema_system* system, int phase, void* failure) -> bool override {
        switch (phase) {
        case 0:
            build_client_types();
            return true;
        case 2:
            return system->methods->install_classes(
                system, nullptr, "client", client_types.data(), 118, client_classes.data(), failure
            );
        default:
            return true;
        }
    }
};

entity_registration entity_registrar{};
client_registration client_registrar{};

// Inlined into InstallSchemaBindings or not per fixture (CMakeLists.txt).
[[SCHEMA_GAME_INSTALLER]] auto install_all(schema_system* system) -> void {
    for (int phase = 0; phase < 4; ++phase) {
        for (registration* each = registrations; each != nullptr; each = each->next()) {
            each->install(system, phase, nullptr);
        }
    }
}

// Static initializers the CRT runs before DllMain, one per registrar, as MSVC places them.
auto link_entity() -> void {
    entity_registrar.link(registrations);
}

auto link_client() -> void {
    client_registrar.link(registrations);
}

}
}

#pragma clang diagnostic pop

#pragma section(".CRT$XCU", read)
[[gnu::used]] __declspec(allocate(".CRT$XCU")) constinit const auto link_entity_at_start =
    &game::link_entity;
[[gnu::used]] __declspec(allocate(".CRT$XCU")) constinit const auto link_client_at_start =
    &game::link_client;

// NOLINTEND(misc-use-internal-linkage)
// NOLINTEND(bugprone-throwing-static-initialization)
// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables)

extern "C" {
// NOLINTNEXTLINE(readability-identifier-naming): the game's export name, which SchemaSystem looks up.
__declspec(dllexport) auto InstallSchemaBindings(const char* version, game::schema_system* system)
    -> bool;
}

auto InstallSchemaBindings(const char* version, game::schema_system* system) -> bool {
    if (std::string_view{version} != "SchemaSystem_001") {
        return false;
    }
    if (!game::is_installed) {
        game::installed_system = system;
        game::install_all(system);
        game::is_installed = true;
    }
    return true;
}
