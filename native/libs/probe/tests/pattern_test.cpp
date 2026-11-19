#include <expected>
#include <optional>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/probe/navigation.hpp>
#include <lucent/probe/strings.hpp>

#include "images.hpp"

namespace lucent::probe {
namespace {

constexpr instruction_pattern row_accessor{
    "movsxd rax, ecx; lea rcx, [rip+$table]; shl rax, 6; add rax, rcx; ret"
};
constexpr isize table = row_accessor.capture("table");

constexpr instruction_pattern scaled_entry{"and %index, 0x1ff; imul ?, %index, $size"};
constexpr instruction_pattern scaled_entry_apart{"and %index, 0x1ff; ...; imul ?, %index, $size"};
constexpr instruction_pattern field_read{"mov rax, [rcx+$offset]; ret"};
constexpr instruction_pattern forwarding_call{"call $callee; ret"};

static_assert(row_accessor.steps().size() == 5);
static_assert(table == 0);
static_assert(scaled_entry_apart.steps().size() == 3);
static_assert(scaled_entry_apart.steps().subspan(1).front().is_gap);
static_assert(scaled_entry.capture("size") == 0);

// The matches starting at the export, which is where the fixture's code for it starts.
auto matches_at(
    const module_file& module, const instruction_pattern& pattern, std::string_view export_name
) -> std::vector<pattern_match> {
    const u32 start = export_rva(module, export_name);
    std::vector<pattern_match> found;
    for (const pattern_match& each : matches_in_code(module, pattern)) {
        if (each.rva == start) {
            found.push_back(each);
        }
    }
    return found;
}

TEST_CASE("a pattern finds an indexed accessor and captures the table it reads off rip") {
    const module_file game = game_module();
    const u32 rows = export_rva(game, "fixture_rows");

    const std::vector<pattern_match> found = matches_at(game, row_accessor, "fixture_row");
    REQUIRE(found.size() == 1);
    CHECK(found.front().captures.at(table) == rows);
    CHECK(found.front().end > found.front().rva);
}

TEST_CASE("two accessors of one table are one finding; accessors of two tables are ambiguous") {
    const module_file game = game_module();
    const u32 rows = export_rva(game, "fixture_rows");
    const std::vector<pattern_match> all = matches_in_code(game, row_accessor);

    std::vector<pattern_match> of_rows;
    for (const pattern_match& each : all) {
        if (each.rva == export_rva(game, "fixture_row")
            || each.rva == export_rva(game, "fixture_row_again")) {
            of_rows.push_back(each);
        }
    }
    REQUIRE(of_rows.size() == 2);
    CHECK(one(captured(of_rows, table)) == finding{rows});
    CHECK(one(captured(all, table)) == finding{std::unexpected(miss::ambiguous)});
}

TEST_CASE("a register variable holds one register across steps, at any of its widths") {
    const module_file game = game_module();

    const std::vector<pattern_match> found = matches_at(game, scaled_entry, "fixture_entry");
    REQUIRE(found.size() == 1);
    CHECK(found.front().captures.at(0) == 0x70);
    CHECK(matches_at(game, scaled_entry, "fixture_entry_mismatched").empty());
    CHECK(matches_at(game, scaled_entry_apart, "fixture_entry_mismatched").empty());
}

TEST_CASE("a gap lets the steps around it skip the instructions between them") {
    const module_file game = game_module();

    CHECK(matches_at(game, scaled_entry, "fixture_entry_apart").empty());
    const std::vector<pattern_match> found =
        matches_at(game, scaled_entry_apart, "fixture_entry_apart");
    REQUIRE(found.size() == 1);
    CHECK(found.front().captures.at(0) == 0x70);
}

TEST_CASE("captures read a displacement off a register, and a call's target as an RVA") {
    const module_file game = game_module();

    const std::vector<pattern_match> field = matches_at(game, field_read, "fixture_field");
    REQUIRE(field.size() == 1);
    CHECK(field.front().captures.at(0) == 0x48);
    const std::vector<pattern_match> call = matches_at(game, forwarding_call, "fixture_forward");
    REQUIRE(call.size() == 1);
    CHECK(call.front().captures.at(0) == export_rva(game, "fixture_marker"));
}

TEST_CASE("a build path's tail finds the string's start, which leads to the function naming it") {
    const module_file game = game_module();
    const code_index index = code_index::build(game);
    const std::optional<pe::runtime_function> describe =
        game.function_containing(export_rva(game, "fixture_describe"));
    REQUIRE(describe.has_value());

    const std::vector<u32> paths = strings_ending_with(game, R"(\game\client\view.cpp)");
    REQUIRE(paths.size() == 1);
    CHECK(string_rvas(game, R"(C:\buildworker\fixture\src\game\client\view.cpp)") == paths);
    CHECK(
        functions_referencing(game, index, paths.front())
        == std::vector{describe.value_or(pe::runtime_function{})}
    );
    CHECK(strings_ending_with(game, R"(\server\view.cpp)").empty());
}

TEST_CASE("the callers of a function are the functions with unwind data that call it") {
    const module_file game = game_module();
    const code_index index = code_index::build(game);
    const std::optional<pe::runtime_function> describe =
        game.function_containing(export_rva(game, "fixture_describe"));
    REQUIRE(describe.has_value());

    CHECK(
        callers_of(game, index, export_rva(game, "fixture_sink"))
        == std::vector{describe.value_or(pe::runtime_function{})}
    );
    // The forwarding call is a leaf without unwind data, so it has no function to report.
    CHECK(callers_of(game, index, export_rva(game, "fixture_marker")).empty());
}

}
}
