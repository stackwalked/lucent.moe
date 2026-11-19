#include "latency/step_log.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <flat_map>
#include <format>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/unique_handle.hpp>

#include "cache/binaries.hpp"

namespace lucent::facts {
namespace {

auto step_name(pipeline_step step) -> std::string_view {
    switch (step) {
    case pipeline_step::ingest:
        return "ingest";
    case pipeline_step::generate:
        return "generate";
    }
    LUCENT_UNREACHABLE();
}

auto outcome_name(step_outcome outcome) -> std::string_view {
    switch (outcome) {
    case step_outcome::new_build:
        return "new-build";
    case step_outcome::cached:
        return "cached";
    case step_outcome::resolved:
        return "resolved";
    case step_outcome::partial:
        return "partial";
    case step_outcome::failed:
        return "failed";
    }
    LUCENT_UNREACHABLE();
}

constexpr std::array steps{pipeline_step::ingest, pipeline_step::generate};
constexpr std::array outcomes{
    step_outcome::new_build,
    step_outcome::cached,
    step_outcome::resolved,
    step_outcome::partial,
    step_outcome::failed,
};

auto step_named(std::string_view name) -> std::optional<pipeline_step> {
    const auto found = std::ranges::find(steps, name, &step_name);
    return found == steps.end() ? std::nullopt : std::optional{*found};
}

auto outcome_named(std::string_view name) -> std::optional<step_outcome> {
    const auto found = std::ranges::find(outcomes, name, &outcome_name);
    return found == outcomes.end() ? std::nullopt : std::optional{*found};
}

auto json_string(std::string_view text) -> std::string {
    std::string quoted = "\"";
    for (const char letter : text) {
        if (letter == '"' || letter == '\\') {
            quoted.push_back('\\');
            quoted.push_back(letter);
        } else if (static_cast<u8>(letter) < 0x20) {
            quoted += std::format("\\u{:04x}", static_cast<u8>(letter));
        } else {
            quoted.push_back(letter);
        }
    }
    quoted.push_back('"');
    return quoted;
}

auto time_text(wall_time time) -> std::string {
    return std::format("{:%FT%T}Z", time);
}

auto number_at(std::string_view text, usize offset, usize width) -> std::optional<i32> {
    if (offset + width > text.size()) {
        return std::nullopt;
    }
    const std::string_view digits = text.substr(offset, width);
    i32 value = 0;
    const auto [end, failure] =
        std::from_chars(std::to_address(digits.begin()), std::to_address(digits.end()), value);
    if (failure != std::errc{} || end != std::to_address(digits.end())) {
        return std::nullopt;
    }
    return value;
}

// Exactly the form time_text writes: 2026-11-19T10:00:00.123Z.
auto time_from(std::string_view text) -> std::optional<wall_time> {
    constexpr usize length = 24;
    if (text.size() != length
        || text.at(4) != '-'
        || text.at(7) != '-'
        || text.at(10) != 'T'
        || text.at(13) != ':'
        || text.at(16) != ':'
        || text.at(19) != '.'
        || text.back() != 'Z') {
        return std::nullopt;
    }
    const std::optional<i32> year = number_at(text, 0, 4);
    const std::optional<i32> month = number_at(text, 5, 2);
    const std::optional<i32> day = number_at(text, 8, 2);
    const std::optional<i32> hour = number_at(text, 11, 2);
    const std::optional<i32> minute = number_at(text, 14, 2);
    const std::optional<i32> second = number_at(text, 17, 2);
    const std::optional<i32> millisecond = number_at(text, 20, 3);
    if (!year || !month || !day || !hour || !minute || !second || !millisecond) {
        return std::nullopt;
    }
    const std::chrono::year_month_day date{
        std::chrono::year{*year},
        std::chrono::month{narrow<u32>(*month)},
        std::chrono::day{narrow<u32>(*day)},
    };
    if (!date.ok()) {
        return std::nullopt;
    }
    return std::chrono::sys_days{date} + std::chrono::hours{*hour} + std::chrono::minutes{*minute}
           + std::chrono::seconds{*second} + std::chrono::milliseconds{*millisecond};
}

// Reads a JSON string starting at its opening quote; advances past the closing one. Only the
// escapes json_string writes.
auto string_at(std::string_view line, usize& cursor) -> std::optional<std::string> {
    if (cursor >= line.size() || line.at(cursor) != '"') {
        return std::nullopt;
    }
    std::string text;
    for (++cursor; cursor < line.size(); ++cursor) {
        const char letter = line.at(cursor);
        if (letter == '"') {
            ++cursor;
            return text;
        }
        if (letter != '\\') {
            text.push_back(letter);
            continue;
        }
        ++cursor;
        if (cursor >= line.size()) {
            return std::nullopt;
        }
        const char escaped = line.at(cursor);
        if (escaped == '"' || escaped == '\\') {
            text.push_back(escaped);
            continue;
        }
        if (escaped != 'u' || cursor + 4 >= line.size()) {
            return std::nullopt;
        }
        u8 code = 0;
        const std::string_view hex = line.substr(cursor + 1, 4);
        const auto [end, failure] =
            std::from_chars(std::to_address(hex.begin()), std::to_address(hex.end()), code, 16);
        if (failure != std::errc{} || end != std::to_address(hex.end())) {
            return std::nullopt;
        }
        text.push_back(static_cast<char>(code));
        cursor += 4;
    }
    return std::nullopt;
}

auto skip_spaces(std::string_view line, usize& cursor) -> void {
    while (cursor < line.size() && (line.at(cursor) == ' ' || line.at(cursor) == '\t')) {
        ++cursor;
    }
}

// A flat object of string members, the only shape this log holds.
auto members_of(std::string_view line) -> std::optional<std::flat_map<std::string, std::string>> {
    std::flat_map<std::string, std::string> members;
    usize cursor = 0;
    skip_spaces(line, cursor);
    if (cursor >= line.size() || line.at(cursor) != '{') {
        return std::nullopt;
    }
    ++cursor;
    while (true) {
        skip_spaces(line, cursor);
        std::optional<std::string> key = string_at(line, cursor);
        skip_spaces(line, cursor);
        if (!key || cursor >= line.size() || line.at(cursor) != ':') {
            return std::nullopt;
        }
        ++cursor;
        skip_spaces(line, cursor);
        std::optional<std::string> value = string_at(line, cursor);
        if (!value) {
            return std::nullopt;
        }
        members.insert_or_assign(*std::move(key), *std::move(value));
        skip_spaces(line, cursor);
        if (cursor >= line.size()) {
            return std::nullopt;
        }
        if (line.at(cursor) == '}') {
            return members;
        }
        if (line.at(cursor) != ',') {
            return std::nullopt;
        }
        ++cursor;
    }
}

auto member(const std::flat_map<std::string, std::string>& members, std::string_view key)
    -> std::optional<std::string> {
    const auto found = members.find(std::string{key});
    return found == members.end() ? std::nullopt : std::optional{found->second};
}

auto latest_of(std::span<const step_record> records, const module_run& run, pipeline_step step)
    -> const step_record* {
    const step_record* latest = nullptr;
    for (const step_record& record : records) {
        if (record.module == run.module && record.build == run.build && record.step == step) {
            latest = &record;
        }
    }
    return latest;
}

auto run_of(std::span<const step_record> records, const std::string& module) -> module_run {
    const auto last = std::ranges::find_last(records, module, &step_record::module);
    module_run run{
        .module = module,
        .build = last.begin()->build,
        .first_seen = std::nullopt,
        .steps = {},
        .latency = std::nullopt,
    };
    const step_record* first_written = nullptr;
    for (const step_record& record : records) {
        if (record.module != run.module || record.build != run.build) {
            continue;
        }
        const bool is_first_sight = record.step == pipeline_step::ingest
                                    && record.outcome == step_outcome::new_build
                                    && !run.first_seen;
        if (is_first_sight) {
            run.first_seen = record.start;
        }
        const bool has_written =
            record.step == pipeline_step::generate && record.outcome != step_outcome::failed;
        if (has_written && run.first_seen && first_written == nullptr) {
            first_written = &record;
        }
    }
    for (const pipeline_step step : steps) {
        if (const step_record* latest = latest_of(records, run, step)) {
            run.steps.push_back(*latest);
        }
    }
    if (first_written != nullptr && run.first_seen) {
        run.latency = first_written->end - *run.first_seen;
    }
    return run;
}

auto duration_text(std::chrono::milliseconds span) -> std::string {
    const std::chrono::hh_mm_ss<std::chrono::milliseconds> parts{span};
    if (parts.hours().count() > 0) {
        return std::format(
            "{}h{:02}m{:02}s",
            parts.hours().count(),
            parts.minutes().count(),
            parts.seconds().count()
        );
    }
    if (parts.minutes().count() > 0) {
        return std::format("{}m{:02}s", parts.minutes().count(), parts.seconds().count());
    }
    return std::format("{:.3f}s", static_cast<double>(span.count()) / 1000.0);
}

}

auto step_log_of(const binaries_cache& cache) -> std::filesystem::path {
    return cache.root / L"update-day.jsonl";
}

auto to_json_line(const step_record& record) -> std::string {
    return std::format(
        R"({{"module":{},"build":{},"step":{},"outcome":{},"start":{},"end":{},"detail":{}}})",
        json_string(record.module),
        json_string(record.build),
        json_string(step_name(record.step)),
        json_string(outcome_name(record.outcome)),
        json_string(time_text(record.start)),
        json_string(time_text(record.end)),
        json_string(record.detail)
    );
}

auto from_json_line(std::string_view line) -> std::optional<step_record> {
    const std::optional<std::flat_map<std::string, std::string>> members = members_of(line);
    if (!members) {
        return std::nullopt;
    }
    const std::optional<std::string> module = member(*members, "module");
    const std::optional<std::string> build = member(*members, "build");
    const std::optional<std::string> step = member(*members, "step");
    const std::optional<std::string> outcome = member(*members, "outcome");
    const std::optional<std::string> start = member(*members, "start");
    const std::optional<std::string> end = member(*members, "end");
    if (!module || !build || !step || !outcome || !start || !end) {
        return std::nullopt;
    }
    const std::optional<pipeline_step> step_value = step_named(*step);
    const std::optional<step_outcome> outcome_value = outcome_named(*outcome);
    const std::optional<wall_time> start_value = time_from(*start);
    const std::optional<wall_time> end_value = time_from(*end);
    if (!step_value || !outcome_value || !start_value || !end_value) {
        return std::nullopt;
    }
    return step_record{
        .module = *module,
        .build = *build,
        .step = *step_value,
        .outcome = *outcome_value,
        .start = *start_value,
        .end = *end_value,
        .detail = member(*members, "detail").value_or(std::string{}),
    };
}

auto append_step(const std::filesystem::path& log, const step_record& record) -> result<void> {
    std::error_code failure;
    std::filesystem::create_directories(log.parent_path(), failure);
    // FILE_APPEND_DATA alone: every write lands at the end, whoever else has the log open.
    const os::unique_handle file{CreateFileW(
        log.c_str(),
        FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    )};
    if (!file.is_valid()) {
        return std::unexpected(last_system_error());
    }
    const std::string line = to_json_line(record) + "\n";
    DWORD written = 0;
    const BOOL is_written =
        WriteFile(file.native(), line.data(), narrow<DWORD>(line.size()), &written, nullptr);
    if (is_written == 0 || written != line.size()) {
        return std::unexpected(last_system_error());
    }
    return {};
}

auto read_steps(const std::filesystem::path& log) -> std::vector<step_record> {
    const result<std::vector<std::byte>> bytes = os::read_file(log);
    if (!bytes) {
        return {};
    }
    std::string text;
    for (const std::byte part : *bytes) {
        text.push_back(static_cast<char>(part));
    }
    std::vector<step_record> records;
    for (const auto line : text | std::views::split('\n')) {
        std::string_view entry{line};
        if (entry.ends_with('\r')) {
            entry.remove_suffix(1);
        }
        if (std::optional<step_record> record = from_json_line(entry)) {
            records.push_back(*std::move(record));
        }
    }
    return records;
}

auto latest_runs(std::span<const step_record> records) -> std::vector<module_run> {
    std::vector<std::string> modules;
    for (const step_record& record : records) {
        if (!std::ranges::contains(modules, record.module)) {
            modules.push_back(record.module);
        }
    }
    std::vector<module_run> runs;
    runs.reserve(modules.size());
    for (const std::string& module : modules) {
        runs.push_back(run_of(records, module));
    }
    return runs;
}

auto describe(std::span<const module_run> runs) -> std::string {
    if (runs.empty()) {
        return "no update-day runs logged yet\n";
    }
    std::string text;
    for (const module_run& run : runs) {
        text += std::format("{} {}\n", run.module, run.build);
        text += run.first_seen ? std::format("  first seen  {}\n", time_text(*run.first_seen))
                               : std::string{"  first seen  before the log began\n"};
        for (const step_record& step : run.steps) {
            text += std::format(
                "  {:<10}  {}  {:>9}  {:<9}  {}\n",
                step_name(step.step),
                time_text(step.start),
                duration_text(step.end - step.start),
                outcome_name(step.outcome),
                step.detail
            );
        }
        if (const std::optional<std::chrono::milliseconds> latency = run.latency) {
            text += std::format(
                "  latency     {} from first seen to values\n", duration_text(*latency)
            );
        } else {
            text += "  latency     not on record\n";
        }
    }
    return text;
}

}
