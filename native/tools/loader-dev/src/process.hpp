#pragma once

#include <filesystem>
#include <string_view>

#include <lucent/kit/unique_handle.hpp>

namespace lucent::loader_dev {

// The first running process whose executable has this name, compared case-insensitively.
auto find_process(std::wstring_view executable) -> result<u32>;

// A handle with exactly the rights injection needs.
auto open_process(u32 process_id) -> result<kit::unique_handle>;

// Where a module loaded from this path sits in the process.
auto module_base(u32 process_id, const std::filesystem::path& module) -> result<uptr>;

}
