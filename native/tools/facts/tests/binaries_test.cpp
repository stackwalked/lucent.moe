#include "cache/binaries.hpp"

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>

#include "scratch_directory.hpp"

namespace lucent::facts {
namespace {

auto own_file() -> std::vector<std::byte> {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    result<std::vector<std::byte>> bytes = os::read_file(path);
    REQUIRE(bytes.has_value());
    return *std::move(bytes);
}

// This test executable's file, a real PE, as another build: its TimeDateStamp rewritten.
auto build_file(const std::filesystem::path& directory, u32 time_date_stamp)
    -> std::filesystem::path {
    std::vector<std::byte> bytes = own_file();
    constexpr usize new_header_offset = 0x3c;
    constexpr usize stamp_in_headers = 8;
    u32 headers = 0;
    for (usize i = 0; i < 4; ++i) {
        headers |= std::to_integer<u32>(bytes.at(new_header_offset + i)) << (8 * i);
    }
    for (usize i = 0; i < 4; ++i) {
        bytes.at(headers + stamp_in_headers + i) =
            static_cast<std::byte>((time_date_stamp >> (8 * i)) & 0xffU);
    }
    std::filesystem::path file = directory / std::format(L"source-{:08x}.dll", time_date_stamp);
    REQUIRE(os::write_file(file, bytes).has_value());
    return file;
}

auto ingest_build(const binaries_cache& cache, const std::filesystem::path& file) -> ingested {
    result<ingested> made = ingest(cache, {.file = file, .label = "test install"}, "Client.dll");
    REQUIRE(made.has_value());
    return *std::move(made);
}

auto folders_in(const std::filesystem::path& directory) -> std::vector<std::string> {
    std::vector<std::string> names;
    for (const std::filesystem::directory_entry& entry :
        std::filesystem::directory_iterator{directory}) {
        if (entry.is_directory()) {
            names.push_back(entry.path().filename().string());
        }
    }
    std::ranges::sort(names);
    return names;
}

auto text_in(const std::filesystem::path& file) -> std::string {
    const result<std::vector<std::byte>> bytes = os::read_file(file);
    REQUIRE(bytes.has_value());
    std::string text;
    for (const std::byte part : *bytes) {
        text.push_back(static_cast<char>(part));
    }
    return text;
}

}

TEST_CASE("a snapshot is keyed by the module's lowercased name, TimeDateStamp and SizeOfImage") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-keying");
    const binaries_cache cache{.root = scratch / "cache"};
    const ingested made = ingest_build(cache, build_file(scratch, 0x6afe3e44));

    CHECK(made.is_new);
    CHECK(made.taken.build.time_date_stamp == 0x6afe3e44);
    const std::string folder = build_name(made.taken.build);
    CHECK(folder.starts_with("6afe3e44-"));
    CHECK(folder == std::format("6afe3e44-{:x}", made.taken.build.size_of_image));
    CHECK(made.taken.directory == cache.root / "client.dll" / folder);
    CHECK(made.taken.file == made.taken.directory / "Client.dll");
    CHECK(text_in(cache.root / "client.dll" / "latest") == folder);
}

TEST_CASE("a snapshot records the SHA-256 of the file it copied") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-sha256");
    const binaries_cache cache{.root = scratch / "cache"};
    const ingested made = ingest_build(cache, build_file(scratch, 0x11111111));

    const std::string digest = text_in(made.taken.directory / "sha256.txt");
    CHECK(digest.size() == 65);
    CHECK(digest.ends_with('\n'));
    // A copy holds the same bytes as its source.
    CHECK(
        os::read_file(made.taken.file).value_or(std::vector<std::byte>{})
        == os::read_file(scratch / "source-11111111.dll").value_or(std::vector<std::byte>{1})
    );
}

TEST_CASE("ingesting a build already cached copies nothing and keeps it latest") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-again");
    const binaries_cache cache{.root = scratch / "cache"};
    const std::filesystem::path file = build_file(scratch, 0x22222222);
    const ingested first = ingest_build(cache, file);
    REQUIRE(first.is_new);

    const ingested again = ingest_build(cache, file);

    CHECK_FALSE(again.is_new);
    CHECK(folders_in(cache.root / "client.dll").size() == 1);
    CHECK_FALSE(previous_build_directory(cache, "client.dll").has_value());
}

TEST_CASE("the cache keeps a module's latest build and the one before it, and prunes older ones") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-pruning");
    const binaries_cache cache{.root = scratch / "cache"};
    const ingested first = ingest_build(cache, build_file(scratch, 0x10000000));
    const ingested second = ingest_build(cache, build_file(scratch, 0x20000000));
    const ingested third = ingest_build(cache, build_file(scratch, 0x30000000));

    const std::vector<std::string> kept = folders_in(cache.root / "client.dll");
    CHECK(
        kept
        == std::vector<std::string>{build_name(second.taken.build), build_name(third.taken.build)}
    );
    CHECK_FALSE(std::filesystem::exists(first.taken.directory));
    const result<snapshot> latest = latest_snapshot(cache, "client.dll");
    REQUIRE(latest.has_value());
    CHECK(latest->build == third.taken.build);
    CHECK(previous_build_directory(cache, "client.dll") == second.taken.directory);
}

TEST_CASE("going back to the previous build keeps both builds") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-rollback");
    const binaries_cache cache{.root = scratch / "cache"};
    const std::filesystem::path older = build_file(scratch, 0x10000000);
    const ingested first = ingest_build(cache, older);
    const ingested second = ingest_build(cache, build_file(scratch, 0x20000000));

    const ingested back = ingest_build(cache, older);

    CHECK_FALSE(back.is_new);
    const result<snapshot> latest = latest_snapshot(cache, "client.dll");
    REQUIRE(latest.has_value());
    CHECK(latest->build == first.taken.build);
    CHECK(previous_build_directory(cache, "client.dll") == second.taken.directory);
    CHECK(folders_in(cache.root / "client.dll").size() == 2);
}

TEST_CASE("a module never ingested has no latest build") {
    const std::filesystem::path scratch = fresh_directory("facts-cache-empty");
    const binaries_cache cache{.root = scratch / "cache"};

    CHECK_FALSE(latest_snapshot(cache, "client.dll").has_value());
    CHECK_FALSE(previous_build_directory(cache, "client.dll").has_value());
}

}
