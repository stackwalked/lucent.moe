#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>

#include <lucent/bundle/fact_set.hpp>

namespace lucent::facts {

// The binaries cache: <root>\<module>\<TimeDateStamp>-<SizeOfImage>\ per module build, holding the
// module file, its SHA-256 and a label for the install it came from (label.txt); <root>\<module>\
// latest and previous name the two builds kept. Outside git, as every game binary is.
struct binaries_cache {
    std::filesystem::path root;
};

// %LOCALAPPDATA%\lucent\binaries: per user rather than per checkout, so every worktree reads the
// same snapshots and the latency log outlives the worktree that wrote it.
auto user_binaries_cache() -> result<binaries_cache>;

// One module build as the cache holds it.
struct snapshot {
    std::string module;
    bundle::module_key build;
    std::filesystem::path directory;
    std::filesystem::path file;
};

struct ingested {
    snapshot taken;
    // False when that build was in the cache already.
    bool is_new = false;
};

// A module file to snapshot, and a label for where it came from (Steam's build id, say), kept
// beside it for the report.
struct module_source {
    std::filesystem::path file;
    std::string label;
};

// The build's folder name in the cache, which the latency log uses too.
auto build_name(const bundle::module_key& build) -> std::string;

// Copies the module file into the cache under its build and makes it the module's latest.
// The cache keeps the latest build and the one before it, for checking a new finder isn't
// overfit to one build; older builds are deleted.
auto ingest(const binaries_cache& cache, const module_source& source, std::string_view module)
    -> result<ingested>;

// The module's latest build in the cache: not_found until one is ingested.
auto latest_snapshot(const binaries_cache& cache, std::string_view module) -> result<snapshot>;

// The folder of the build the latest replaced, while the cache still holds it.
auto previous_build_directory(const binaries_cache& cache, std::string_view module)
    -> std::optional<std::filesystem::path>;

}
