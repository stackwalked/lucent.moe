#include <lucent/source2-probe/schema.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/source2-probe/module_schema.hpp>

#include "fixtures/schema_layout.hpp"

namespace lucent::source2 {
namespace {

auto fixture_path() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_FIXTURE_SCHEMA_GAME};
}

auto fixture() -> probe::module_file {
    const result<std::vector<std::byte>> file = os::read_file(fixture_path());
    REQUIRE(file.has_value());
    result<probe::module_file> loaded = probe::module_file::load(*file);
    REQUIRE(loaded.has_value());
    return std::move(*loaded);
}

auto own_module() -> probe::module_file {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    path.resize(size);
    const result<std::vector<std::byte>> file = os::read_file(path);
    REQUIRE(file.has_value());
    result<probe::module_file> loaded = probe::module_file::load(*file);
    REQUIRE(loaded.has_value());
    return std::move(*loaded);
}

// The fixture's schema as read from its file.
struct read_fixture {
    probe::module_file module;
    probe::code_index index;
    module_schema schema;
};

auto read_fixture_schema() -> read_fixture {
    probe::module_file module = fixture();
    probe::code_index index = probe::code_index::build(module);
    result<module_schema> schema = read_schema(module, index);
    REQUIRE(schema.has_value());
    return read_fixture{
        .module = std::move(module),
        .index = std::move(index),
        .schema = std::move(*schema),
    };
}

auto class_named(const module_schema& schema, std::string_view name) -> const declared_class& {
    const std::vector<const declared_class*> found = classes_named(schema, name);
    REQUIRE(found.size() == 1);
    return *found.front();
}

auto type_of(const declared_class& owner, std::string_view field) -> std::optional<std::string> {
    const auto found = std::ranges::find(owner.fields, field, &declared_field::name);
    REQUIRE(found != owner.fields.end());
    return found->type;
}

auto offset_of(const declared_class& owner, std::string_view field) -> i32 {
    const auto found = std::ranges::find(owner.fields, field, &declared_field::name);
    REQUIRE(found != owner.fields.end());
    return found->offset;
}

TEST_CASE("the reader lists every class the module's registrars hand SchemaSystem, by project") {
    const read_fixture read = read_fixture_schema();

    CHECK(read.schema.classes.size() == 6);
    CHECK(read.schema.rejected == 0);
    CHECK(class_named(read.schema, "CFixtureInstance").project == "entity");
    CHECK(class_named(read.schema, "C_FixtureEntity").project == "client");
    CHECK(class_named(read.schema, "CFixtureWeaponVData").project == "client");
}

TEST_CASE("a class's size and bases come from its record, with each base's offset") {
    const read_fixture read = read_fixture_schema();

    const declared_class& entity = class_named(read.schema, "C_FixtureEntity");
    CHECK(entity.size == 0x600);
    CHECK(entity.bases == std::vector{declared_base{.name = "CFixtureInstance", .offset = 0}});
    CHECK(
        class_named(read.schema, "C_FixtureController").bases
        == std::vector{declared_base{.name = "C_FixtureEntity", .offset = 0}}
    );
    CHECK(class_named(read.schema, "CFixtureSceneNode").bases.empty());
}

TEST_CASE("a base whose record the class's callback links at registration is read through it") {
    const read_fixture read = read_fixture_schema();

    CHECK(
        class_named(read.schema, "CFixtureWeaponVData").bases
        == std::vector{declared_base{.name = "CFixtureVDataBase", .offset = 0x10}}
    );
}

TEST_CASE("a field tagged with a slot of its project's type table has the type phase 0 put there") {
    const read_fixture read = read_fixture_schema();

    const declared_class& entity = class_named(read.schema, "C_FixtureEntity");
    CHECK(offset_of(entity, "m_iHealth") == 0x34c);
    CHECK(type_of(entity, "m_iHealth") == "int32");
    CHECK(type_of(entity, "m_iTeamNum") == "uint8");
    CHECK(type_of(entity, "m_vecAbsVelocity") == "Vector");
    CHECK(type_of(entity, "m_hOwnerEntity") == "CHandle< C_FixtureEntity >");
    CHECK(type_of(class_named(read.schema, "CFixtureInstance"), "m_iszName") == "CUtlSymbolLarge");
}

TEST_CASE("a field its class's callback types is named as SchemaSystem names what was built") {
    const read_fixture read = read_fixture_schema();

    const declared_class& entity = class_named(read.schema, "C_FixtureEntity");
    CHECK(type_of(entity, "m_pGameSceneNode") == "CFixtureSceneNode*");
    CHECK(type_of(entity, "m_bDirty") == "bitfield:3");
    const declared_class& node = class_named(read.schema, "CFixtureSceneNode");
    CHECK(type_of(node, "m_boneTransforms") == "float32[4][3]");
    CHECK(type_of(node, "m_children") == "CUtlVector< CFixtureSceneNode* >");
    CHECK(type_of(node, "m_slots") == "CUtlVectorFixedGrowable< int32, 8 >");
    CHECK(type_of(node, "m_weights") == "CUtlMap< int32, float32 >");
    CHECK(type_of(node, "m_dirtyBones") == "CBitVec< 10 >");
    CHECK(type_of(node, "m_nodeKind") == "FixtureNodeKind_t");
    CHECK(type_of(node, "m_vecAbsOrigin") == "VectorWS");
    const declared_class& controller = class_named(read.schema, "C_FixtureController");
    CHECK(type_of(controller, "m_hPawn") == "CHandle< C_FixturePawn >");
    CHECK(type_of(controller, "m_iszPlayerName") == "char[128]");
}

TEST_CASE("a module that registers no schema has none to read") {
    const probe::module_file module = own_module();
    const probe::code_index index = probe::code_index::build(module);

    CHECK(!read_schema(module, index).has_value());
}

TEST_CASE("a schema finder yields the field's offset when the schema names the type it expects") {
    const read_fixture read = read_fixture_schema();
    constexpr probe::finder health = schema<"C_FixtureEntity", "m_iHealth", "int32">();
    constexpr probe::finder name = schema<"C_FixtureController", "m_iszPlayerName", "char[128]">();

    CHECK(health.rests_on == probe::basis::semantic);
    CHECK(health.run(read.module, read.index) == probe::finding{0x34c});
    CHECK(name.run(read.module, read.index) == probe::finding{0x6fc});
}

TEST_CASE("a schema finder finds nothing when the field's schema type isn't the one it expects") {
    const read_fixture read = read_fixture_schema();
    constexpr probe::finder health = schema<"C_FixtureEntity", "m_iHealth", "float32">();

    CHECK(
        health.run(read.module, read.index) == probe::finding{std::unexpected(probe::miss::none)}
    );
}

TEST_CASE("a schema finder finds nothing for a class or field the schema doesn't have") {
    const read_fixture read = read_fixture_schema();
    constexpr probe::finder no_class = schema<"C_Missing", "m_iHealth", "int32">();
    constexpr probe::finder no_field = schema<"C_FixtureEntity", "m_iArmor", "int32">();

    CHECK(
        no_class.run(read.module, read.index) == probe::finding{std::unexpected(probe::miss::none)}
    );
    CHECK(
        no_field.run(read.module, read.index) == probe::finding{std::unexpected(probe::miss::none)}
    );
}

TEST_CASE("size and base finders yield a class's size and a base's offset from the schema") {
    const read_fixture read = read_fixture_schema();
    constexpr probe::finder size = schema_size<"C_FixtureController">();
    constexpr probe::finder base = schema_base<"CFixtureWeaponVData", "CFixtureVDataBase">();

    CHECK(size.run(read.module, read.index) == probe::finding{0x800});
    CHECK(base.run(read.module, read.index) == probe::finding{0x10});
}

// SchemaSystem as the tests play it against the loaded fixture: a type is its name, as
// schemasystem.dll formats it, and each class is copied out when its project is installed.
struct played_scope {
    game::type_scope scope;
    std::vector<std::unique_ptr<std::string>>* names;
};

struct played_system {
    game::schema_system system;
    played_scope* types;
    std::vector<declared_class>* registered;
};

static_assert(std::is_standard_layout_v<played_scope>);
static_assert(std::is_standard_layout_v<played_system>);

constexpr std::array<std::string_view, 14> builtin_names{
    "Invalid",
    "void",
    "char",
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
    "float32",
    "float64",
    "bool",
};

// NOLINTBEGIN(cppcoreguidelines-pro-type-reinterpret-cast): a played object is reached from the
// game object that is its first member, and a type is the name it points at.
auto made(const game::type_scope* scope, game::type** out, std::string name) -> game::type** {
    const auto* owner = reinterpret_cast<const played_scope*>(scope);
    owner->names->push_back(std::make_unique<std::string>(std::move(name)));
    *out = reinterpret_cast<game::type*>(owner->names->back().get());
    return out;
}

auto name_of(const game::type* made_type) -> std::string {
    return *reinterpret_cast<const std::string*>(made_type);
}

auto system_of(game::schema_system* system) -> played_system& {
    return *reinterpret_cast<played_system*>(system);
}

// NOLINTEND(cppcoreguidelines-pro-type-reinterpret-cast)

// NOLINTBEGIN(cppcoreguidelines-pro-type-vararg): the target's own signature, read back.
// NOLINTBEGIN(modernize-avoid-variadic-functions): the target's own signature.
// NOLINTBEGIN(misc-const-correctness): the target's own signature.
auto played_multi_array(
    game::type_scope* scope, game::type** out, game::type* element, i32 /*size*/, i32 alignment, ...
) -> game::type** {
    std::vector<i32> dimensions;
    std::va_list rest{};
    va_start(rest, alignment);
    for (i32 dimension = va_arg(rest, i32); dimension != -1; dimension = va_arg(rest, i32)) {
        dimensions.push_back(dimension);
    }
    va_end(rest);
    std::string name = name_of(element);
    for (const i32 dimension : dimensions | std::views::reverse) {
        name = std::format("{}[{}]", name, dimension);
    }
    return made(scope, out, std::move(name));
}

// NOLINTEND(misc-const-correctness)
// NOLINTEND(modernize-avoid-variadic-functions)
// NOLINTEND(cppcoreguidelines-pro-type-vararg)

constexpr game::type_scope_methods played_scope_methods{
    .unused = {},
    .builtin = [](game::type_scope* scope, game::type** out, i32 kind) -> game::type** {
        return made(scope, out, std::string{builtin_names.at(narrow<usize>(kind))});
    },
    .pointer = [](game::type_scope* scope, game::type** out, game::type* pointee) -> game::type** {
        return made(scope, out, name_of(pointee) + "*");
    },
    .atomic = [](
                  game::type_scope* scope, game::type** out, const char* name, i32, char
              ) -> game::type** { return made(scope, out, name); },
    .atomic_of_type = [](game::type_scope* scope,
                          game::type** out,
                          const char* name,
                          i32,
                          char,
                          game::type* argument) -> game::type** {
        return made(scope, out, std::format("{}< {} >", name, name_of(argument)));
    },
    .collection = [](game::type_scope* scope,
                      game::type** out,
                      const char* name,
                      i32,
                      char,
                      i16,
                      game::type* element,
                      std::uint64_t fixed,
                      void*) -> game::type** {
        return made(
            scope,
            out,
            fixed == 0 ? std::format("{}< {} >", name, name_of(element))
                       : std::format("{}< {}, {} >", name, name_of(element), fixed)
        );
    },
    .atomic_of_two_types = [](game::type_scope* scope,
                               game::type** out,
                               const char* name,
                               i32,
                               char,
                               game::type* first,
                               game::type* second) -> game::type** {
        return made(scope, out, std::format("{}< {}, {} >", name, name_of(first), name_of(second)));
    },
    .atomic_of_number =
        [](
            game::type_scope* scope, game::type** out, const char* name, i32, char, i32 number
        ) -> game::type** { return made(scope, out, std::format("{}< {} >", name, number)); },
    .declared_class = [](game::type_scope* scope,
                          game::type** out,
                          const char* name) -> game::type** { return made(scope, out, name); },
    .declared_enum = [](game::type_scope* scope,
                         game::type** out,
                         const char* name) -> game::type** { return made(scope, out, name); },
    .fixed_array =
        [](
            game::type_scope* scope, game::type** out, game::type* element, i32 count, i16, char
        ) -> game::type** {
        return made(scope, out, std::format("{}[{}]", name_of(element), count));
    },
    .multi_array = &played_multi_array,
    .bitfield = [](game::type_scope* scope, game::type** out, i32 bits) -> game::type** {
        return made(scope, out, std::format("bitfield:{}", bits));
    },
};

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage" // the module's records, counted by it
// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic): the module's records, as above.

auto field_type_of(const game::field_record& field, game::type* const* table) -> std::string {
    if ((field.type & game::table_tag) == game::table_tag) {
        return name_of(table[field.type & ~game::table_tag]);
    }
    return name_of(std::bit_cast<const game::type*>(field.type));
}

auto copied(const game::class_record& record, std::string_view project, game::type* const* table)
    -> declared_class {
    declared_class copy{
        .name = record.name,
        .project = std::string{project},
        .size = record.size,
        .bases = {},
        .fields = {},
    };
    for (const game::field_record& field :
        std::span{record.fields, narrow<usize>(record.field_count)}) {
        copy.fields.push_back(
            declared_field{
                .name = field.name,
                .offset = field.offset,
                .type = field_type_of(field, table),
            }
        );
    }
    for (const game::base_record& base : std::span{record.bases, record.base_count}) {
        copy.bases.push_back(
            declared_base{.name = base.owner->name, .offset = narrow<i32>(base.offset)}
        );
    }
    return copy;
}

// NOLINTBEGIN(misc-const-correctness): SchemaSystem's signature.
auto played_install(
    game::schema_system* system,
    void* /*module*/,
    const char* project,
    game::type** table,
    i32 /*table_version*/,
    game::class_record* const* classes,
    void* /*failure*/
) -> bool {
    // NOLINTEND(misc-const-correctness)
    const played_system& played = system_of(system);
    for (game::class_record* const* at = classes; *at != nullptr; ++at) {
        game::class_record& record = **at;
        record.scope = &played.types->scope;
        if (record.callback != nullptr) {
            record.callback(0, &record);
            record.callback(1, &record);
        }
        played.registered->push_back(copied(record, project, table));
    }
    return true;
}

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
#pragma clang diagnostic pop

constexpr game::schema_system_methods played_system_methods{
    .unused_before_scope = {},
    .find_type_scope = [](game::schema_system* system, void*, i32) -> game::type_scope* {
        return &system_of(system).types->scope;
    },
    .unused_before_install = {},
    .install_classes = &played_install,
};

auto by_name(std::vector<declared_class> classes) -> std::vector<declared_class> {
    std::ranges::sort(classes, {}, &declared_class::name);
    return classes;
}

TEST_CASE("the offline reading is what the module registers when SchemaSystem runs it") {
    const read_fixture read = read_fixture_schema();
    std::vector<std::unique_ptr<std::string>> names;
    std::vector<declared_class> registered;
    played_scope scope{.scope = {.methods = &played_scope_methods}, .names = &names};
    played_system played{
        .system = {.methods = &played_system_methods},
        .types = &scope,
        .registered = &registered,
    };
    const HMODULE loaded = LoadLibraryW(fixture_path().c_str());
    REQUIRE(loaded != nullptr);
    using install_fn = auto (*)(const char*, game::schema_system*)->bool;
    const auto install = std::bit_cast<install_fn>(
        std::bit_cast<uptr>(GetProcAddress(loaded, "InstallSchemaBindings"))
    );
    REQUIRE(install != nullptr);

    CHECK(install("SchemaSystem_001", &played.system));

    CHECK(by_name(read.schema.classes) == by_name(registered));
    FreeLibrary(loaded);
}

}
}
