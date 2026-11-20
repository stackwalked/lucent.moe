#pragma once

#include <lucent/kit/boot_info.hpp>

namespace lucent::kit::detail {

// Where the host says a mapped image keeps its entry and .pdata, from its base.
struct image_layout {
    u32 entry_rva = 0;
    u32 pdata_rva = 0;
    u32 pdata_size = 0;
};

// RUNTIME_FUNCTION: begin, end and unwind info, three u32s, each entry aligned to one.
inline constexpr u32 runtime_function_size = 12;

// Whether the layout fits an image of that size: an entry inside it, and whole, aligned
// RUNTIME_FUNCTIONs inside it or no .pdata at all. The host wrote the layout, so a misfit is bad
// input, not a bug of ours.
constexpr auto fits(const image_layout& layout, u64 image_size) -> bool {
    if (layout.entry_rva == 0 || layout.entry_rva >= image_size) {
        return false;
    }
    if (layout.pdata_size == 0) {
        return layout.pdata_rva == 0;
    }
    return layout.pdata_size % runtime_function_size == 0
           && layout.pdata_rva % sizeof(u32) == 0
           && u64{layout.pdata_rva} + layout.pdata_size <= image_size;
}

static_assert(fits({.entry_rva = 0x1000, .pdata_rva = 0x3000, .pdata_size = 24}, 0x4000));
static_assert(fits({.entry_rva = 0x1000, .pdata_rva = 0, .pdata_size = 0}, 0x2000));
static_assert(!fits({.entry_rva = 0, .pdata_rva = 0, .pdata_size = 0}, 0x2000));
static_assert(!fits({.entry_rva = 0x2000, .pdata_rva = 0, .pdata_size = 0}, 0x2000));
static_assert(!fits({.entry_rva = 0x1000, .pdata_rva = 0x3ff4, .pdata_size = 24}, 0x4000));
static_assert(!fits({.entry_rva = 0x1000, .pdata_rva = 0x3000, .pdata_size = 20}, 0x4000));
static_assert(!fits({.entry_rva = 0x1000, .pdata_rva = 0x3002, .pdata_size = 12}, 0x4000));
static_assert(!fits({.entry_rva = 0x1000, .pdata_rva = 0x3000, .pdata_size = 0}, 0x4000));
static_assert(!fits({.entry_rva = 0x1000, .pdata_rva = 0xffff'fff4, .pdata_size = 24}, 0x4000));

// The module's own image as the host placed it, and what freeing it takes.
struct own_image {
    image_kind kind = image_kind::loaded;
    // Where the image is, either kind: its allocation as the host made it.
    uptr base = 0;
    u64 size = 0;
    // Mapped only; 0 for none.
    u64 trampolines = 0;
    // Mapped only, absolute; 0 for none.
    uptr entry = 0;
    uptr function_table = 0;
};

// At boot, before any of the module's code may raise: a mapped image's .pdata registered, once
// its layout fits the image's own allocation. A loaded image is the OS loader's and needs nothing.
// The registration stays if the start fails afterwards, as the image stays mapped.
auto adopt_image(const boot_info& info) -> result<own_image>;

// Ends the lifecycle thread by freeing the module the way its image was loaded. The last call on
// that thread, and only once nothing else can run the module's code.
[[noreturn]] auto release_module(const own_image& image) -> void;

}
