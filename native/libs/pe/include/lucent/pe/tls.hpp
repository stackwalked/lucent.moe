#pragma once

#include <optional>
#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

// An image's static TLS. The directory stores addresses for the base the image was linked for;
// these are offsets from the base instead.
struct tls_info {
    // The template every thread's TLS block starts as, followed by zero_fill_size zero bytes.
    rva_range template_data;
    u32 zero_fill_size = 0;
    // Where the loader stores the image's TLS index.
    u32 index_rva = 0;
    std::vector<u32> callback_rvas;
};

// Absent when the image has no TLS directory.
auto tls_of(const image_view& image) -> result<std::optional<tls_info>>;

}
