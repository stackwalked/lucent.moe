#include "update/install.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <variant>
#include <vector>

#include <Windows.h>

#include <KnownFolders.h>
#include <ShObjIdl.h>
#include <ShlObj.h>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/release_seal.hpp>

#include "api/server.hpp"
#include "text/base64url.hpp"

namespace lucent::loader {
namespace {

// The loader and host are a few MiB each; this bounds a download, not a plan.
constexpr usize max_artifact_size = usize{64} << 20U;

auto own_path() -> result<std::filesystem::path> {
    std::array<wchar_t, 32'768> buffer{};
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), narrow<DWORD>(buffer.size()));
    if (length == 0 || length == buffer.size()) {
        return std::unexpected(last_system_error());
    }
    return std::filesystem::path{std::wstring_view{buffer.data(), length}};
}

auto hresult_failure(HRESULT status) -> error {
    return error{.code = error_code::system, .system_code = std::bit_cast<u32>(status)};
}

auto digest_of(const wire::release_seal& seal, wire::artifact_kind kind)
    -> std::optional<crypto::digest> {
    for (const wire::release_artifact& artifact : seal.artifacts) {
        if (artifact.kind == kind) {
            return artifact.digest;
        }
    }
    return std::nullopt;
}

// One artifact, whole, or the server's refusal; its bytes are checked against the seal before
// anything is written.
auto download(server& api, std::string_view access_token, const crypto::digest& digest)
    -> result<std::variant<std::vector<std::byte>, wire::refusal>> {
    const std::string path = std::format("/v1/artifacts/{}", to_hex(digest));
    std::vector<std::byte> bytes;
    const auto keep = [&bytes](std::span<const std::byte> piece) -> result<void> {
        bytes.insert(bytes.end(), piece.begin(), piece.end());
        return {};
    };
    const std::optional<wire::refusal> refused = LUCENT_TRY(api.stream(
        call{
            .method = "GET",
            .path = path,
            .access_token = access_token,
            .body = {},
            .kind = operation::none,
            .max_body = max_artifact_size,
        },
        keep
    ));
    if (refused) {
        return *refused;
    }
    if (crypto::hash(bytes) != digest) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    return bytes;
}

// The shortcut's file, under the user's Start menu programs.
auto shortcut_path() -> result<std::filesystem::path> {
    PWSTR found = nullptr;
    const HRESULT status = SHGetKnownFolderPath(FOLDERID_Programs, 0, nullptr, &found);
    if (FAILED(status)) {
        CoTaskMemFree(found);
        return std::unexpected(hresult_failure(status));
    }
    std::filesystem::path path = std::filesystem::path{found} / L"Lucent.lnk";
    CoTaskMemFree(found);
    return path;
}

// This thread's COM apartment, left when this object goes.
class com_apartment final {
public:
    static auto enter() -> result<com_apartment> {
        const HRESULT started = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(started)) {
            return std::unexpected(hresult_failure(started));
        }
        return com_apartment{};
    }

    com_apartment(const com_apartment&) = delete ("CoUninitialize once");
    auto operator=(const com_apartment&) -> com_apartment& = delete ("CoUninitialize once");

    com_apartment(com_apartment&& other) noexcept
        : m_is_entered{std::exchange(other.m_is_entered, false)} {}

    auto operator=(com_apartment&&) -> com_apartment& = delete ("bound to its thread");

    ~com_apartment() {
        if (m_is_entered) {
            CoUninitialize();
        }
    }

private:
    com_apartment() = default;

    bool m_is_entered = true;
};

// A COM interface pointer, released with this object.
template <typename Interface>
class com_ptr final {
public:
    com_ptr() = default;
    com_ptr(const com_ptr&) = delete ("Release once");
    auto operator=(const com_ptr&) -> com_ptr& = delete ("Release once");
    com_ptr(com_ptr&&) = delete ("filled in place");
    auto operator=(com_ptr&&) -> com_ptr& = delete ("filled in place");

    ~com_ptr() {
        if (pointer != nullptr) {
            pointer->Release();
        }
    }

    Interface* pointer = nullptr;
};

// Where COM writes the interface it hands back, as its void** out parameters take it.
template <typename Interface>
auto out_pointer(com_ptr<Interface>& held) -> void** {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): COM's out parameters are void**, written with the asked interface's pointer.
    return reinterpret_cast<void**>(&held.pointer);
}

}

namespace {

// A release directory's name as its seal number; nothing for any other name (a .part, say).
auto number_of(const std::filesystem::path& name) -> std::optional<u64> {
    const std::string text = name.string();
    u64 number = 0;
    const std::from_chars_result parsed =
        std::from_chars(std::to_address(text.begin()), std::to_address(text.end()), number);
    if (text.empty() || parsed.ec != std::errc{} || parsed.ptr != std::to_address(text.end())) {
        return std::nullopt;
    }
    return number;
}

// Whether the directory already holds exactly what the seal names: then it is used as it is,
// never rewritten under a loader that may be running from it.
struct release_files {
    std::span<const std::byte> seal;
    crypto::digest loader{};
    crypto::digest host{};
};

auto is_complete(const std::filesystem::path& directory, const release_files& expected) -> bool {
    const result<std::vector<std::byte>> seal = os::read_file(directory / seal_file);
    const result<std::vector<std::byte>> loader = os::read_file(directory / loader_file);
    const result<std::vector<std::byte>> host = os::read_file(directory / host_file);
    return seal
           && loader
           && host
           && std::ranges::equal(*seal, expected.seal)
           && crypto::hash(*loader) == expected.loader
           && crypto::hash(*host) == expected.host;
}

}

auto release_directory(const std::filesystem::path& root, u64 number) -> std::filesystem::path {
    return root / L"releases" / std::to_wstring(number);
}

auto running_release(const std::filesystem::path& root) -> std::optional<u64> {
    const result<std::filesystem::path> running = own_path();
    if (!running) {
        return std::nullopt;
    }
    const std::filesystem::path directory = running->parent_path();
    if (directory.parent_path() != root / L"releases" || running->filename() != loader_file) {
        return std::nullopt;
    }
    return number_of(directory.filename());
}

auto install_release(
    server& api,
    std::string_view access_token,
    const std::filesystem::path& root,
    const wire::release_seal& seal,
    std::span<const std::byte> seal_bytes
) -> result<install_outcome> {
    const std::optional<crypto::digest> loader_digest =
        digest_of(seal, wire::artifact_kind::loader);
    const std::optional<crypto::digest> host_digest = digest_of(seal, wire::artifact_kind::host);
    if (!loader_digest || !host_digest) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    const std::filesystem::path final_directory = release_directory(root, seal.number);
    const release_files expected{
        .seal = seal_bytes,
        .loader = *loader_digest,
        .host = *host_digest,
    };
    if (is_complete(final_directory, expected)) {
        return installed{.loader = final_directory / loader_file};
    }
    const answer loader = LUCENT_TRY(download(api, access_token, *loader_digest));
    if (const std::optional<wire::refusal> refused = refusal_in(loader)) {
        return *refused;
    }
    const answer host = LUCENT_TRY(download(api, access_token, *host_digest));
    if (const std::optional<wire::refusal> refused = refusal_in(host)) {
        return *refused;
    }
    std::filesystem::path staging = final_directory;
    staging += L".part";
    std::error_code failure;
    std::filesystem::remove_all(staging, failure);
    std::filesystem::create_directories(staging, failure);
    LUCENT_TRY(os::write_file(staging / loader_file, body_in(loader)));
    LUCENT_TRY(os::write_file(staging / host_file, body_in(host)));
    LUCENT_TRY(os::write_file(staging / seal_file, seal_bytes));
    std::filesystem::remove_all(final_directory, failure);
    std::filesystem::rename(staging, final_directory, failure);
    if (failure) {
        return std::unexpected(
            // std::error_code::value() is the OS code itself, not an unchecked unwrap.
            // ast-grep-ignore: no-value-unwrap
            error{.code = error_code::system, .system_code = narrow<u32>(failure.value())}
        );
    }
    return installed{.loader = final_directory / loader_file};
}

auto point_shortcut(const std::filesystem::path& loader) -> result<void> {
    const std::filesystem::path link = LUCENT_TRY(shortcut_path());
    const com_apartment apartment = LUCENT_TRY(com_apartment::enter());
    com_ptr<IShellLinkW> shell_link;
    HRESULT status = CoCreateInstance(
        CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_IShellLinkW, out_pointer(shell_link)
    );
    if (FAILED(status)) {
        return std::unexpected(hresult_failure(status));
    }
    shell_link.pointer->SetPath(loader.c_str());
    shell_link.pointer->SetWorkingDirectory(loader.parent_path().c_str());
    shell_link.pointer->SetDescription(L"Lucent");
    com_ptr<IPersistFile> file;
    status = shell_link.pointer->QueryInterface(IID_IPersistFile, out_pointer(file));
    if (FAILED(status)) {
        return std::unexpected(hresult_failure(status));
    }
    status = file.pointer->Save(link.c_str(), TRUE);
    if (FAILED(status)) {
        return std::unexpected(hresult_failure(status));
    }
    return {};
}

auto hand_over(const std::filesystem::path& loader) -> result<void> {
    // The command line as this process got it, program name and all, with the new program in
    // front: the arguments carry over unchanged.
    const std::wstring_view given{GetCommandLineW()};
    const usize program_end = given.starts_with(L'"') ? given.find(L'"', 1) + 1 : given.find(L' ');
    const std::wstring_view arguments =
        program_end == std::wstring_view::npos ? std::wstring_view{} : given.substr(program_end);
    std::wstring command = std::format(L"\"{}\"{}", loader.wstring(), arguments);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION started{};
    if (CreateProcessW(
            loader.c_str(),
            command.data(),
            nullptr,
            nullptr,
            FALSE,
            0,
            nullptr,
            loader.parent_path().c_str(),
            &startup,
            &started
        )
        == FALSE) {
        return std::unexpected(last_system_error());
    }
    CloseHandle(started.hThread);
    CloseHandle(started.hProcess);
    return {};
}

auto prune_releases(const std::filesystem::path& root, u64 current) -> void {
    std::error_code failure;
    const std::filesystem::path releases = root / L"releases";
    std::vector<std::filesystem::path> others;
    std::optional<u64> previous;
    for (const std::filesystem::directory_entry& entry :
        std::filesystem::directory_iterator{releases, failure}) {
        const std::optional<u64> number = number_of(entry.path().filename());
        if (number == current) {
            continue;
        }
        if (number && *number < current && (!previous || *number > *previous)) {
            previous = number;
        }
        others.push_back(entry.path());
    }
    for (const std::filesystem::path& path : others) {
        if (previous && path == release_directory(root, *previous)) {
            continue;
        }
        // Best effort: a directory still in use (a loader that hasn't exited) goes next time.
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
}

}
