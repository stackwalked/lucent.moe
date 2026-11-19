#pragma once

#include <filesystem>
#include <string>
#include <string_view>

#include <lucent/bundle/fact_set.hpp>

namespace lucent::facts {

// One module build as the binaries cache holds it: %LOCALAPPDATA%\lucent\binaries\<module>\
// <TimeDateStamp>-<SizeOfImage>\, holding the module file, its SHA-256 and a label for the install
// it came from (label.txt). Outside git, as every game binary is.
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

// Copies the module file into the cache under its build and makes it the module's latest.
// The cache keeps the latest build and the one before it, for checking a new finder isn't
// overfit to one build; older builds are deleted.
auto ingest(const module_source& source, std::string_view module) -> result<ingested>;

// The module's latest build in the cache: not_found until one is ingested.
auto latest_snapshot(std::string_view module) -> result<snapshot>;

}
