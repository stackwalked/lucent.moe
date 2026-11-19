#include "latency/step_log.hpp"

#include <chrono>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/os/file.hpp>

#include "scratch_directory.hpp"

namespace lucent::facts {
namespace {

// 2026-11-19 10:00:00 UTC, and minutes after it.
auto at(i32 minutes) -> wall_time {
    using namespace std::chrono_literals;
    return wall_time{std::chrono::sys_days{2026y / 11 / 19}} + 10h + std::chrono::minutes{minutes};
}

auto step(std::string_view build, pipeline_step kind, step_outcome outcome, i32 minute)
    -> step_record {
    return step_record{
        .module = "client.dll",
        .build = std::string{build},
        .step = kind,
        .outcome = outcome,
        .start = at(minute),
        .end = at(minute + 1),
        .detail = {},
    };
}

}

TEST_CASE("a log line reads back as the record that wrote it") {
    const step_record record{
        .module = "client.dll",
        .build = "6afe3e44-298d000",
        .step = pipeline_step::generate,
        .outcome = step_outcome::partial,
        .start = at(0) + std::chrono::milliseconds{123},
        .end = at(2) + std::chrono::milliseconds{7},
        .detail = "quote \" backslash \\ tab \t done",
    };

    const std::string line = to_json_line(record);

    CHECK(line.contains(R"("start":"2026-11-19T10:00:00.123Z")"));
    CHECK_FALSE(line.contains('\t'));
    CHECK(from_json_line(line) == record);
}

TEST_CASE("a line this tool didn't write is no record") {
    CHECK_FALSE(from_json_line("").has_value());
    CHECK_FALSE(from_json_line("not json").has_value());
    CHECK_FALSE(from_json_line(R"({"module":"client.dll"})").has_value());
    CHECK_FALSE(from_json_line(
        R"({"module":"m","build":"b","step":"probe","outcome":"failed","start":"2026-11-19T10:00:00.000Z","end":"2026-11-19T10:00:00.000Z"})"
    )
            .has_value());
    CHECK_FALSE(from_json_line(
        R"({"module":"m","build":"b","step":"ingest","outcome":"failed","start":"2026-13-19T10:00:00.000Z","end":"2026-11-19T10:00:00.000Z"})"
    )
            .has_value());
}

TEST_CASE("appending keeps every earlier line and skips what doesn't parse") {
    const std::filesystem::path scratch = fresh_directory("facts-step-log-append");
    const std::filesystem::path log = scratch / "logs" / "update-day.jsonl";
    const step_record first = step("a", pipeline_step::ingest, step_outcome::new_build, 0);
    const step_record second = step("a", pipeline_step::generate, step_outcome::resolved, 1);

    REQUIRE(append_step(log, first).has_value());
    const std::string junk = "a person's note\n";
    std::vector<std::byte> with_junk = os::read_file(log).value_or(std::vector<std::byte>{});
    with_junk.append_range(std::as_bytes(std::span{junk}));
    REQUIRE(os::write_file(log, with_junk).has_value());
    REQUIRE(append_step(log, second).has_value());

    CHECK(read_steps(log) == std::vector<step_record>{first, second});
}

TEST_CASE("a log that doesn't exist yet holds no records") {
    const std::filesystem::path scratch = fresh_directory("facts-step-log-missing");

    CHECK(read_steps(scratch / "update-day.jsonl").empty());
}

TEST_CASE(
    "latency runs from when ingest first saw the build to the first generate that wrote values"
) {
    const std::vector<step_record> records{
        step("new", pipeline_step::ingest, step_outcome::new_build, 0),
        step("new", pipeline_step::generate, step_outcome::failed, 5),
        step("new", pipeline_step::ingest, step_outcome::cached, 30),
        step("new", pipeline_step::generate, step_outcome::partial, 40),
        step("new", pipeline_step::generate, step_outcome::resolved, 90),
    };

    const std::vector<module_run> runs = latest_runs(records);

    REQUIRE(runs.size() == 1);
    CHECK(runs.front().first_seen == at(0));
    CHECK(runs.front().latency == std::chrono::minutes{41});
    REQUIRE(runs.front().steps.size() == 2);
    CHECK(runs.front().steps.at(0) == records.at(2));
    CHECK(runs.front().steps.at(1) == records.at(4));
}

TEST_CASE("each module's run is its latest build's, and an older build's steps don't count") {
    std::vector<step_record> records{
        step("old", pipeline_step::ingest, step_outcome::new_build, 0),
        step("old", pipeline_step::generate, step_outcome::resolved, 1),
        step("next", pipeline_step::ingest, step_outcome::new_build, 60),
    };
    step_record engine = step("e1", pipeline_step::ingest, step_outcome::new_build, 61);
    engine.module = "engine2.dll";
    records.push_back(engine);

    const std::vector<module_run> runs = latest_runs(records);

    REQUIRE(runs.size() == 2);
    CHECK(runs.at(0).module == "client.dll");
    CHECK(runs.at(0).build == "next");
    CHECK(runs.at(0).first_seen == at(60));
    CHECK_FALSE(runs.at(0).latency.has_value());
    CHECK(runs.at(1).module == "engine2.dll");
}

TEST_CASE("a build cached before the log began has no first sighting and no latency") {
    const std::vector<step_record> records{
        step("known", pipeline_step::ingest, step_outcome::cached, 0),
        step("known", pipeline_step::generate, step_outcome::resolved, 1),
    };

    const std::vector<module_run> runs = latest_runs(records);

    REQUIRE(runs.size() == 1);
    CHECK_FALSE(runs.front().first_seen.has_value());
    CHECK_FALSE(runs.front().latency.has_value());
    CHECK(describe(runs).contains("before the log began"));
}

}
