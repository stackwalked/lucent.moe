#include "cache/binaries.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <optional>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include <Windows.h>
// After Windows.h, which defines the types bcrypt.h uses.
#include <bcrypt.h>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::factgen {
namespace {

constexpr usize sha256_size = 32;

auto lowercase(std::string_view text) -> std::string {
    std::string lowered{text};
    std::ranges::transform(lowered, lowered.begin(), [](char letter) {
        return letter >= 'A' && letter <= 'Z' ? static_cast<char>(letter - 'A' + 'a') : letter;
    });
    return lowered;
}

auto module_directory(std::string_view module) -> result<std::filesystem::path> {
    const DWORD size = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
    if (size == 0) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    std::wstring local(size, L'\0');
    const DWORD written = GetEnvironmentVariableW(L"LOCALAPPDATA", local.data(), size);
    if (written == 0 || written >= size) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    local.resize(written);
    return std::filesystem::path{local} / L"lucent" / L"binaries" / to_wide(lowercase(module));
}

auto build_folder(const bundle::module_key& build) -> std::string {
    return std::format("{:08x}-{:x}", build.time_date_stamp, build.size_of_image);
}

auto sha256_of(std::span<const std::byte> bytes) -> result<std::string> {
    std::array<UCHAR, sha256_size> digest{};
    // BCryptHash takes PUCHAR input; std::byte and UCHAR share one object representation.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast,cppcoreguidelines-pro-type-const-cast): BCrypt's input parameter isn't const but isn't written.
    auto* const input = reinterpret_cast<PUCHAR>(const_cast<std::byte*>(bytes.data()));
    const NTSTATUS status = BCryptHash(
        BCRYPT_SHA256_ALG_HANDLE,
        nullptr,
        0,
        input,
        narrow<ULONG>(bytes.size()),
        digest.data(),
        narrow<ULONG>(digest.size())
    );
    if (!BCRYPT_SUCCESS(status)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = static_cast<u32>(status)}
        );
    }
    std::string text;
    for (const UCHAR part : digest) {
        text += std::format("{:02x}", part);
    }
    return text;
}

auto write_text(const std::filesystem::path& path, std::string_view text) -> result<void> {
    return os::write_file(path, std::as_bytes(std::span{text}));
}

auto read_text(const std::filesystem::path& path) -> std::optional<std::string> {
    const result<std::vector<std::byte>> bytes = os::read_file(path);
    if (!bytes) {
        return std::nullopt;
    }
    std::string text;
    for (const std::byte part : *bytes) {
        text.push_back(static_cast<char>(part));
    }
    return text;
}

// Deletes every build folder but these two.
auto prune(const std::filesystem::path& directory, std::string_view latest, std::string_view kept)
    -> void {
    std::error_code failure;
    std::vector<std::filesystem::path> stale;
    for (const std::filesystem::directory_entry& entry :
        std::filesystem::directory_iterator{directory, failure}) {
        const std::string name = entry.path().filename().string();
        if (entry.is_directory(failure) && name != latest && name != kept) {
            stale.push_back(entry.path());
        }
    }
    for (const std::filesystem::path& folder : stale) {
        std::filesystem::remove_all(folder, failure);
    }
}

auto write_snapshot(const std::filesystem::path& file, std::span<const std::byte> bytes)
    -> result<void> {
    const std::filesystem::path directory = file.parent_path();
    std::error_code failure;
    std::filesystem::create_directories(directory, failure);
    LUCENT_TRY(os::write_file(file, bytes));
    const std::string digest = LUCENT_TRY(sha256_of(bytes));
    return write_text(directory / L"sha256.txt", digest + "\n");
}

// Records the folder as the module's latest build, the one it replaces as the previous, and
// prunes the rest.
auto make_latest(const std::filesystem::path& root, const std::string& folder) -> result<void> {
    const std::optional<std::string> latest = read_text(root / L"latest");
    if (!latest || *latest != folder) {
        if (latest) {
            LUCENT_TRY(write_text(root / L"previous", *latest));
        }
        LUCENT_TRY(write_text(root / L"latest", folder));
    }
    const std::optional<std::string> previous = read_text(root / L"previous");
    prune(root, folder, previous.value_or(std::string{}));
    return {};
}

auto snapshot_in(const std::filesystem::path& directory, std::string_view module)
    -> result<snapshot> {
    const std::filesystem::path file = directory / to_wide(module);
    const std::vector<std::byte> bytes = LUCENT_TRY(os::read_file(file));
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(bytes, pe::layout::file));
    return snapshot{
        .module = std::string{module},
        .build = LUCENT_TRY(kit::module_build_of(image, module)),
        .directory = directory,
        .file = file,
    };
}

}

auto ingest(const module_source& source, std::string_view module) -> result<ingested> {
    const std::vector<std::byte> bytes = LUCENT_TRY(os::read_file(source.file));
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(bytes, pe::layout::file));
    const bundle::module_key build = LUCENT_TRY(kit::module_build_of(image, module));

    const std::filesystem::path root = LUCENT_TRY(module_directory(module));
    const std::string folder = build_folder(build);
    const std::filesystem::path directory = root / to_wide(folder);
    const std::filesystem::path file = directory / to_wide(module);
    std::error_code failure;
    const bool is_new = !std::filesystem::exists(file, failure);
    if (is_new) {
        LUCENT_TRY(write_snapshot(file, bytes));
    }
    // Rewritten each time: the same build can come from another install.
    LUCENT_TRY(write_text(directory / L"label.txt", std::format("{}\n", source.label)));
    LUCENT_TRY(make_latest(root, folder));
    return ingested{
        .taken =
            snapshot{
                .module = std::string{module},
                .build = build,
                .directory = directory,
                .file = file,
            },
        .is_new = is_new,
    };
}

auto latest_snapshot(std::string_view module) -> result<snapshot> {
    const std::filesystem::path root = LUCENT_TRY(module_directory(module));
    const std::optional<std::string> latest = read_text(root / L"latest");
    if (!latest) {
        std::println(stderr, "factgen: no build of {} in the cache; run `factgen ingest`", module);
        return std::unexpected(error{.code = error_code::not_found});
    }
    return snapshot_in(root / to_wide(*latest), module);
}

}
