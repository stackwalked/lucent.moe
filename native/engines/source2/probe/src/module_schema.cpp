#include <lucent/source2-probe/module_schema.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <iterator>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Zycore/Status.h>
#include <Zydis/Decoder.h>
#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>

#include "machine.hpp"

// How a Source 2 module registers its schema, as read from client.dll and schemasystem.dll
// (research/kb/source2/schema-registration.md has the whole picture):
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9); the same
// layout on 1.41.9.2, 1.41.9.7 and 1.41.9.8 (client.dll TimeDateStamps 0x6ada7340, 0x6af4a59c,
// 0x6afd14c1)
// found: in IDA, from the export InstallSchemaBindings: it keeps ISchemaSystem in a global and
// calls the installer, which runs every registrar (a list linked at static init) through phases
// 0..3. Phase 0 builds the project's type table through the type scope, phase 2 hands
// ISchemaSystem (vtable +0x110) the project name, the table and a null-terminated list of class
// records. Each record's callback, run per phase, builds the types the table doesn't hold and
// fills in bases that live in another project.
// breaks: a moved field in the record: classes are rejected or their values wrong; the installer
// or registrars reshaped: read_schema finds nothing (not_found)
namespace lucent::source2 {
namespace {

constexpr std::string_view install_export = "InstallSchemaBindings";
// ISchemaSystem's method taking a project's class list.
constexpr i64 install_classes = 0x110;

// SchemaClassInfoData_t as the module stores it before registration. Offsets in bytes.
// found: 985 records on 1.41.9.7 and every record of 1.41.9.9 hold together this way: names are
// text, every field offset lies inside the size, every base names a listed record
constexpr u32 class_name = 0x08;
constexpr u32 class_size = 0x20;
constexpr u32 class_field_count = 0x24;
constexpr u32 class_base_count = 0x29;
constexpr u32 class_fields = 0x30;
constexpr u32 class_bases = 0x38;
// Filled at registration; the callbacks read the type scope from it.
constexpr u32 class_type_scope = 0x50;
constexpr u32 class_callback = 0x68;

// SchemaClassFieldData_t: name, type, offset; then metadata, which isn't read.
constexpr u32 field_stride = 0x20;
constexpr u32 field_name = 0x00;
constexpr u32 field_type = 0x08;
constexpr u32 field_offset = 0x10;

// SchemaBaseClassInfoData_t: offset, then the base's record.
constexpr u32 base_stride = 0x10;
constexpr u32 base_offset = 0x00;
constexpr u32 base_class = 0x08;

// Before registration a field's type is either null (its class's callback builds it) or a tag:
// the top nibble set, the low bits an index into the project's type table.
// found: m_iHealth's 0xf00000000000000a against client's table slot 10, which phase 0 fills with
// the builtin int32
constexpr u64 type_tag = 0xf000'0000'0000'0000;

// Bounds on walks over the module's data, far above anything real: 985 classes on 1.41.9.9, the
// largest with a few hundred fields.
constexpr isize max_classes = 65'536;
constexpr i64 max_fields = 4096;
constexpr i64 max_size = 0x1000'0000;
constexpr isize max_table_index = 65'536;

// The registration phases a registrar and a class callback run through.
enum class phase : u8 { build_types = 0, link_bases = 1, register_classes = 2 };

constexpr u8 pointer_width = 8;

// The installer walks the registrars: `mov node, [head]; ...; mov vtable, [node]; ...; call
// [vtable]`.
// found: client+0x19d3280 on 1.41.9.7 (InstallSchemaBindings' callee)
// breaks: the walk reshaped, or unoptimized: no head, and read_schema finds nothing
constexpr probe::instruction_pattern walks_registrars{
    "mov %node, [rip+$head]; ...; mov %vtable, [%node]; ...; call [%vtable]"
};

struct project {
    std::string name;
    u64 table = 0;
    u64 classes = 0;

    auto operator==(const project&) const -> bool = default;
};

// A class record's address and the size it declares, which bounds its fields and bases.
struct record_extent {
    u64 address = 0;
    i32 size = 0;
};

// A class record, by its address, and the project whose list holds it.
struct listed_record {
    const project* owner = nullptr;
    u64 record = 0;
};

auto absolute(const probe::module_file& module, u32 rva) -> u64 {
    return module.view().image_base() + rva;
}

auto u64_at(const probe::module_file& module, u64 address) -> std::optional<u64> {
    const std::optional<u32> rva = module.rva_of(address);
    return rva ? module.u64_at(*rva) : std::nullopt;
}

auto text_at(const probe::module_file& module, u64 address) -> std::optional<std::string> {
    const std::optional<u32> rva = module.rva_of(address);
    if (!rva) {
        return std::nullopt;
    }
    result<std::string> text = module.view().string_at(*rva);
    if (!text || text->empty()) {
        return std::nullopt;
    }
    return std::move(*text);
}

auto number_at(const probe::module_file& module, const detail::machine& run, u64 address, u8 width)
    -> std::optional<u64> {
    return detail::number_in(run.load(module, address, width));
}

auto export_rva(const probe::module_file& module, std::string_view name) -> result<u32> {
    const pe::export_table exports = LUCENT_TRY(pe::export_table::from_image(module.view()));
    const pe::export_target target = LUCENT_TRY(exports.find(name));
    return match(
        target,
        [](const pe::export_address& address) -> result<u32> { return address.rva; },
        [](const pe::forwarder&) -> result<u32> {
            return std::unexpected(error{.code = error_code::unsupported});
        }
    );
}

auto schema_system() -> detail::value {
    return detail::object_value{.kind = detail::object_kind::schema_system};
}

auto unknown() -> detail::value {
    return detail::unknown_value{};
}

// Where InstallSchemaBindings keeps ISchemaSystem, and the functions that may walk the registrars:
// itself and those it hands ISchemaSystem to.
struct installation {
    u64 system_global = 0;
    std::vector<u32> installers;
};

auto installation_of(const probe::module_file& module, u32 install) -> result<installation> {
    detail::machine scratch{module};
    const detail::trace seen = scratch.run(
        module, {.rva = install, .arguments = {unknown(), schema_system(), unknown(), unknown()}}
    );
    std::vector<u64> globals;
    for (const detail::store_event& store : seen.stores) {
        if (store.stored == schema_system()) {
            globals.push_back(store.address);
        }
    }
    const probe::finding global = probe::one(globals);
    if (!global) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    // The export itself walks the registrars where the optimizer inlined the installer into it.
    // found: cs2's client.dll (1.41.9.9) calls the installer; a Release build of the fixture
    // inlined it (schema_game_inlined keeps that shape)
    installation found{.system_global = *global, .installers = {install}};
    for (const detail::call_event& call : seen.calls) {
        const std::optional<u64> target = detail::number_in(call.target);
        const std::optional<u32> rva = target ? module.rva_of(*target) : std::nullopt;
        if (rva && call.arguments.at(0) == schema_system()) {
            found.installers.push_back(*rva);
        }
    }
    std::ranges::sort(found.installers);
    const auto [first, last] = std::ranges::unique(found.installers);
    found.installers.erase(first, last);
    return found;
}

auto registrar_head(const probe::module_file& module, std::span<const u32> installers)
    -> std::optional<u32> {
    std::vector<u64> heads;
    for (const u32 installer : installers) {
        const std::optional<pe::runtime_function> function = module.function_containing(installer);
        if (!function) {
            continue;
        }
        const pe::rva_range code{.rva = function->begin, .size = function->end - function->begin};
        heads.append_range(
            probe::captured(
                probe::matches_in(module, code, walks_registrars), walks_registrars.capture("head")
            )
        );
    }
    const probe::finding head = probe::one(heads);
    return head ? std::optional{narrow<u32>(*head)} : std::nullopt;
}

auto is_terminator(ZydisMnemonic mnemonic) -> bool {
    return mnemonic == ZYDIS_MNEMONIC_RET
           || mnemonic == ZYDIS_MNEMONIC_JMP
           || mnemonic == ZYDIS_MNEMONIC_INT3;
}

// The end of the code before rva that has unwind data, or the start of its section.
auto gap_start(const probe::module_file& module, u32 rva) -> std::optional<u32> {
    std::optional<u32> start;
    for (const pe::section& stored : module.view().sections()) {
        if (stored.access.is_executable
            && rva >= stored.virtual_address
            && rva - stored.virtual_address < pe::mapped_size_of(stored)) {
            start = stored.virtual_address;
        }
    }
    if (!start) {
        return std::nullopt;
    }
    const std::span<const pe::runtime_function> functions = module.functions();
    const auto after = std::ranges::upper_bound(functions, rva, {}, &pe::runtime_function::begin);
    if (after != functions.begin()) {
        start = std::max(*start, std::prev(after)->end);
    }
    return *start;
}

// Where the code holding rva starts. A leaf without unwind data starts after whatever ended the
// code before it (a return, a jump, int3 padding), found by decoding the gap up to rva.
auto code_start(const probe::module_file& module, u32 rva) -> std::optional<u32> {
    if (const std::optional<pe::runtime_function> function = module.function_containing(rva)) {
        return function->begin;
    }
    const std::optional<u32> gap = gap_start(module, rva);
    if (!gap) {
        return std::nullopt;
    }
    ZydisDecoder decoder{};
    LUCENT_INVARIANT(
        ZYAN_SUCCESS(ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64))
    );
    const std::optional<std::span<const std::byte>> code =
        module.bytes_at({.rva = *gap, .size = rva - *gap});
    if (!code) {
        return std::nullopt;
    }
    u32 start = *gap;
    usize offset = 0;
    while (offset < code->size()) {
        ZydisDecodedInstruction decoded{};
        const std::span<const std::byte> rest = code->subspan(offset);
        if (!ZYAN_SUCCESS(
                ZydisDecoderDecodeInstruction(&decoder, nullptr, rest.data(), rest.size(), &decoded)
            )) {
            ++offset;
            start = *gap + narrow<u32>(offset);
            continue;
        }
        offset += decoded.length;
        if (is_terminator(decoded.mnemonic)) {
            start = *gap + narrow<u32>(offset);
        }
    }
    return offset == code->size() ? std::optional{start} : std::nullopt;
}

// The registrars' objects, as the code linking each into the list stores it at the head: directly,
// or through a helper handed the head's address.
auto registrars_of(const probe::module_file& module, const probe::code_index& index, u32 head)
    -> std::vector<u64> {
    const u64 head_address = absolute(module, head);
    std::vector<u64> nodes;
    for (const probe::reference& linked : index.references_to(head)) {
        const bool can_store = linked.kind == probe::reference_kind::store
                               || linked.kind == probe::reference_kind::address;
        if (!can_store) {
            continue;
        }
        const std::optional<u32> start = code_start(module, linked.source);
        if (!start) {
            continue;
        }
        detail::machine scratch{module};
        const detail::trace seen = scratch.run(
            module, {.rva = *start, .arguments = {unknown(), unknown(), unknown(), unknown()}}
        );
        for (const detail::store_event& store : seen.stores) {
            const std::optional<u64> node = detail::number_in(store.stored);
            if (store.address == head_address && node && *node != 0) {
                nodes.push_back(*node);
            }
        }
    }
    std::ranges::sort(nodes);
    const auto [first, last] = std::ranges::unique(nodes);
    nodes.erase(first, last);
    return nodes;
}

// A registrar's first virtual function runs it through a phase.
auto registrar_code(const probe::module_file& module, u64 node) -> std::optional<u32> {
    const std::optional<u64> vtable = u64_at(module, node);
    const std::optional<u64> code = vtable ? u64_at(module, *vtable) : std::nullopt;
    const std::optional<u32> rva = code ? module.rva_of(*code) : std::nullopt;
    if (!rva || !module.is_code(*rva)) {
        return std::nullopt;
    }
    return *rva;
}

// A registrar: its object, and the code its first virtual function runs.
struct registrar {
    u64 node = 0;
    u32 code = 0;
};

auto phase_entry(const registrar& running, phase step) -> detail::entry {
    return detail::entry{
        .rva = running.code,
        .arguments = {
            detail::number_value{.bits = running.node},
            schema_system(),
            detail::number_value{.bits = std::to_underlying(step)},
            unknown(),
        },
    };
}

auto projects_in(const probe::module_file& module, const detail::trace& seen)
    -> std::vector<project> {
    std::vector<project> found;
    const detail::value installs =
        detail::method_value{.kind = detail::object_kind::schema_system, .offset = install_classes};
    for (const detail::call_event& call : seen.calls) {
        if (call.target != installs) {
            continue;
        }
        const std::optional<u64> name = detail::number_in(call.arguments.at(2));
        const std::optional<u64> table = detail::number_in(call.arguments.at(3));
        const std::optional<u64> classes = detail::number_in(call.stack_arguments.at(1));
        const std::optional<std::string> text = name ? text_at(module, *name) : std::nullopt;
        if (text && table && classes) {
            found.push_back(project{.name = *text, .table = *table, .classes = *classes});
        }
    }
    return found;
}

auto records_of(const probe::module_file& module, u64 list) -> std::vector<u64> {
    std::vector<u64> records;
    for (isize position = 0; position < max_classes; ++position) {
        const std::optional<u64> record =
            u64_at(module, list + narrow<u64>(position * pointer_width));
        if (!record || *record == 0) {
            break;
        }
        records.push_back(*record);
    }
    return records;
}

auto run_callback(const probe::module_file& module, detail::machine& run, u64 record) -> void {
    run.write(
        record + class_type_scope,
        detail::object_value{.kind = detail::object_kind::type_scope},
        pointer_width
    );
    const std::optional<u64> callback = u64_at(module, record + class_callback);
    const std::optional<u32> code = callback ? module.rva_of(*callback) : std::nullopt;
    if (!code || !module.is_code(*code)) {
        return;
    }
    for (const phase step : {phase::build_types, phase::link_bases}) {
        run.settle(
            module,
            {
                .rva = *code,
                .arguments = {
                    detail::number_value{.bits = std::to_underlying(step)},
                    detail::number_value{.bits = record},
                    unknown(),
                    unknown(),
                },
            }
        );
    }
}

auto type_of(
    const probe::module_file& module, const detail::machine& run, const project& owner, u64 field
) -> std::optional<std::string> {
    const detail::value stored = run.load(module, field + field_type, pointer_width);
    const auto named = [&](const detail::value& held) -> std::optional<std::string> {
        return match(
            held,
            [&](const detail::type_value& made) -> std::optional<std::string> {
                return std::string{run.type_name(made.index)};
            },
            [](const auto&) -> std::optional<std::string> { return std::nullopt; }
        );
    };
    if (std::optional<std::string> built = named(stored)) {
        return built;
    }
    const std::optional<u64> tag = detail::number_in(stored);
    if (!tag || (*tag & type_tag) != type_tag) {
        return std::nullopt;
    }
    const u64 slot = *tag & ~type_tag;
    if (slot >= max_table_index) {
        return std::nullopt;
    }
    return named(run.load(module, owner.table + (slot * pointer_width), pointer_width));
}

auto signed_at(const probe::module_file& module, const detail::machine& run, u64 address)
    -> std::optional<i32> {
    const std::optional<u64> number = number_at(module, run, address, 4);
    return number ? std::optional{static_cast<i32>(static_cast<u32>(*number))} : std::nullopt;
}

auto fields_of(
    const probe::module_file& module,
    const detail::machine& run,
    const project& owner,
    record_extent record
) -> std::optional<std::vector<declared_field>> {
    const i32 size = record.size;
    const std::optional<u64> count = number_at(module, run, record.address + class_field_count, 2);
    const std::optional<u64> fields =
        number_at(module, run, record.address + class_fields, pointer_width);
    if (!count || !fields || narrow<i64>(*count) > max_fields) {
        return std::nullopt;
    }
    std::vector<declared_field> declared;
    for (const u64 position : std::views::iota(u64{0}, *count)) {
        const u64 field = *fields + (position * field_stride);
        const std::optional<u64> name = number_at(module, run, field + field_name, pointer_width);
        const std::optional<std::string> text = name ? text_at(module, *name) : std::nullopt;
        const std::optional<i32> offset = signed_at(module, run, field + field_offset);
        if (!text || !offset || *offset < 0 || *offset > size) {
            return std::nullopt;
        }
        declared.push_back(
            declared_field{
                .name = *text,
                .offset = *offset,
                .type = type_of(module, run, owner, field),
            }
        );
    }
    return declared;
}

auto bases_of(const probe::module_file& module, const detail::machine& run, record_extent record)
    -> std::optional<std::vector<declared_base>> {
    const i32 size = record.size;
    const std::optional<u64> count = number_at(module, run, record.address + class_base_count, 1);
    if (!count) {
        return std::nullopt;
    }
    std::vector<declared_base> declared;
    if (*count == 0) {
        return declared;
    }
    const std::optional<u64> bases =
        number_at(module, run, record.address + class_bases, pointer_width);
    if (!bases) {
        return std::nullopt;
    }
    for (const u64 position : std::views::iota(u64{0}, *count)) {
        const u64 base = *bases + (position * base_stride);
        const std::optional<i32> offset = signed_at(module, run, base + base_offset);
        const std::optional<u64> owner = number_at(module, run, base + base_class, pointer_width);
        const std::optional<u64> name = owner ? u64_at(module, *owner + class_name) : std::nullopt;
        const std::optional<std::string> text = name ? text_at(module, *name) : std::nullopt;
        if (!text || !offset || *offset < 0 || *offset > size) {
            return std::nullopt;
        }
        declared.push_back(declared_base{.name = *text, .offset = *offset});
    }
    return declared;
}

auto class_at(
    const probe::module_file& module, const detail::machine& run, const project& owner, u64 record
) -> std::optional<declared_class> {
    const std::optional<u64> name = number_at(module, run, record + class_name, pointer_width);
    const std::optional<std::string> text = name ? text_at(module, *name) : std::nullopt;
    const std::optional<i32> size = signed_at(module, run, record + class_size);
    if (!text || !size || *size < 0 || *size > max_size) {
        return std::nullopt;
    }
    std::optional<std::vector<declared_field>> fields =
        fields_of(module, run, owner, {.address = record, .size = *size});
    std::optional<std::vector<declared_base>> bases =
        bases_of(module, run, {.address = record, .size = *size});
    if (!fields || !bases) {
        return std::nullopt;
    }
    return declared_class{
        .name = *text,
        .project = owner.name,
        .size = *size,
        .bases = std::move(*bases),
        .fields = std::move(*fields),
    };
}

auto projects_of(const probe::module_file& module, detail::machine& run, std::span<const u64> nodes)
    -> std::vector<project> {
    std::vector<registrar> registrars;
    for (const u64 node : nodes) {
        if (const std::optional<u32> code = registrar_code(module, node)) {
            registrars.push_back(registrar{.node = node, .code = *code});
        }
    }
    for (const registrar& running : registrars) {
        run.settle(module, phase_entry(running, phase::build_types));
    }
    std::vector<project> found;
    for (const registrar& running : registrars) {
        const detail::trace seen = run.run(module, phase_entry(running, phase::register_classes));
        for (project& each : projects_in(module, seen)) {
            if (!std::ranges::contains(found, each)) {
                found.push_back(std::move(each));
            }
        }
    }
    return found;
}
}

auto read_schema(const probe::module_file& module, const probe::code_index& index)
    -> result<module_schema> {
    const u32 install = LUCENT_TRY(export_rva(module, install_export));
    const installation installed = LUCENT_TRY(installation_of(module, install));
    const std::optional<u32> head = registrar_head(module, installed.installers);
    if (!head) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    const std::vector<u64> nodes = registrars_of(module, index, *head);
    detail::machine run{module};
    run.write(installed.system_global, schema_system(), pointer_width);
    const std::vector<project> projects = projects_of(module, run, nodes);
    if (projects.empty()) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    std::vector<listed_record> records;
    for (const project& each : projects) {
        for (const u64 record : records_of(module, each.classes)) {
            records.push_back(listed_record{.owner = &each, .record = record});
        }
    }
    for (const listed_record& listed : records) {
        run_callback(module, run, listed.record);
    }
    module_schema schema;
    for (const listed_record& listed : records) {
        if (std::optional<declared_class> read =
                class_at(module, run, *listed.owner, listed.record)) {
            schema.classes.push_back(std::move(*read));
        } else {
            ++schema.rejected;
        }
    }
    return schema;
}

auto classes_named(const module_schema& schema, std::string_view name)
    -> std::vector<const declared_class*> {
    std::vector<const declared_class*> found;
    for (const declared_class& each : schema.classes) {
        if (each.name == name) {
            found.push_back(&each);
        }
    }
    return found;
}

}
