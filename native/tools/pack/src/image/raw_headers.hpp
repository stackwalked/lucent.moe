#pragma once

#include <optional>
#include <vector>

#include <lucent/pe/image_view.hpp>

// What the packer needs from the headers that lucent::pe doesn't expose: the debug and delay-load
// directories, and which sections are discardable. Read from the headers image_view has already
// bounds-checked, by the PE32+ layout (Microsoft's PE format documentation).

namespace lucent::pack {

inline constexpr u32 debug_directory = 6;
inline constexpr u32 delay_import_directory = 13;

// Absent when the image doesn't have that directory.
auto raw_directory(const pe::image_view& image, u32 index) -> std::optional<pe::directory>;

inline constexpr u32 discardable_flag = 0x0200'0000;

// Each section's Characteristics, in image_view's section order.
auto section_characteristics(const pe::image_view& image) -> result<std::vector<u32>>;

}
