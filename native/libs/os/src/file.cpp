#include <lucent/os/file.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <vector>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::os {

auto read_file(const std::filesystem::path& path) -> result<std::vector<std::byte>> {
    const unique_handle file{CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    )};
    if (!file.is_valid()) {
        return std::unexpected(last_system_error());
    }
    LARGE_INTEGER size{};
    if (GetFileSizeEx(file.native(), &size) == 0) {
        return std::unexpected(last_system_error());
    }
    std::vector<std::byte> bytes(narrow<usize>(size.QuadPart));
    std::span<std::byte> remaining{bytes};
    while (!remaining.empty()) {
        DWORD read = 0;
        const auto chunk = narrow<DWORD>(std::min<usize>(remaining.size(), MAXDWORD));
        if (ReadFile(file.native(), remaining.data(), chunk, &read, nullptr) == 0) {
            return std::unexpected(last_system_error());
        }
        if (read == 0) {
            // The file shrank while we read it.
            return std::unexpected(error{.code = error_code::malformed});
        }
        remaining = remaining.subspan(read);
    }
    return bytes;
}

}
