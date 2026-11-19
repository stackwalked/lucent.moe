#pragma once

#include <chrono>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "cache/binaries.hpp"

namespace lucent::facts {

using wall_time = std::chrono::sys_time<std::chrono::milliseconds>;

enum class pipeline_step : u8 { ingest, generate };

enum class step_outcome : u8 {
    // Ingest: the build wasn't in the cache, so this is when the pipeline first saw it.
    new_build,
    // Ingest: the build was in the cache already.
    cached,
    // Generate: every fact the module's searches cover resolved.
    resolved,
    // Generate: values were written, but some facts didn't resolve.
    partial,
    failed,
};

// One step run on one module build: a line of the update-day log.
struct step_record {
    std::string module;
    // The build's folder name in the binaries cache.
    std::string build;
    pipeline_step step = pipeline_step::ingest;
    step_outcome outcome = step_outcome::failed;
    wall_time start;
    wall_time end;
    // For people: the Steam build an ingest came from, or what a generate resolved.
    std::string detail;

    auto operator==(const step_record&) const -> bool = default;
};

// update-day.jsonl beside the cache's modules: one JSON object per line, appended, never
// rewritten.
auto step_log_of(const binaries_cache& cache) -> std::filesystem::path;

auto to_json_line(const step_record& record) -> std::string;
// Absent for a line this tool didn't write.
auto from_json_line(std::string_view line) -> std::optional<step_record>;

auto append_step(const std::filesystem::path& log, const step_record& record) -> result<void>;
// Every record in the log, oldest first; none when it doesn't exist yet. Lines that don't parse
// are skipped.
auto read_steps(const std::filesystem::path& log) -> std::vector<step_record>;

// A module's latest build, as the log saw it go through the pipeline.
struct module_run {
    std::string module;
    std::string build;
    // When ingest first found the build new; absent when it was cached before the log began.
    std::optional<wall_time> first_seen;
    // The latest record of each step for this build, in pipeline order.
    std::vector<step_record> steps;
    // From first seen to the end of the first generate that wrote values: the update-day latency
    // up to sign-off.
    std::optional<std::chrono::milliseconds> latency;
};

// One run per module, for each module's latest build, in the order the log first names them.
auto latest_runs(std::span<const step_record> records) -> std::vector<module_run>;

auto describe(std::span<const module_run> runs) -> std::string;

}
