#pragma once

#include <lucent/pe/image_view.hpp>

namespace lucent::kit::detail {

// The COFF header's TimeDateStamp, read from the headers the view already validated. The same
// read serves a file and a loaded image, which is what makes a module build key match across the
// two. Belongs in libs/pe as an image_view query; here until that library grows it.
auto time_date_stamp_of(const pe::image_view& image) -> result<u32>;

}
