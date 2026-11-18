#pragma once

#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

// An entry of the exception directory: the code range [begin, end) one unwind description covers,
// all offsets from the base. A function the compiler split into parts has one entry per part.
struct runtime_function {
    u32 begin = 0;
    u32 end = 0;
    u32 unwind_info = 0;

    auto operator==(const runtime_function&) const -> bool = default;
};

// Sorted by begin and non-overlapping, as the unwinder's binary search requires; empty when the
// image has no exception directory.
auto runtime_functions_of(const image_view& image) -> result<std::vector<runtime_function>>;

}
