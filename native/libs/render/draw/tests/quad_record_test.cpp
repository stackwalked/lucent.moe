#include <lucent/draw/quad_record.hpp>

#include <lucent/draw/color.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/half.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/segment.hpp>

// The record's encodings are constexpr; the shader decodes them the same way, so a drift here is a
// silent wrong picture rather than a crash.

namespace lucent::draw {
namespace {

static_assert(to_half(0.0F) == 0x0000);
static_assert(to_half(-0.0F) == 0x8000);
static_assert(to_half(1.0F) == 0x3c00);
static_assert(to_half(0.5F) == 0x3800);
static_assert(to_half(-2.0F) == 0xc000);
static_assert(to_half(65504.0F) == 0x7bff, "the largest finite half");
static_assert(to_half(65520.0F) == 0x7c00, "rounds past the largest finite half to infinity");
static_assert(to_half(0x1p-24F) == 0x0001, "the smallest subnormal");
static_assert(to_half(0x1p-25F) == 0x0000, "half the smallest subnormal ties to even, zero");
static_assert(to_half(0x1.8p-25F) == 0x0001, "above the tie rounds up");
static_assert(to_half(1.0F + 0x1p-11F) == 0x3c00, "a tie rounds to the even mantissa");
static_assert(to_half(1.0F + 0x1.8p-11F) == 0x3c01, "past the tie rounds up");

static_assert(from_half(0x3c00) == 1.0F);
static_assert(from_half(0x0001) == 0x1p-24F);
static_assert(from_half(0x03ff) == 0x1.ff8p-15F, "the largest subnormal");
static_assert(from_half(to_half(12.5F)) == 12.5F);
static_assert(from_half(to_half(0.1F)) == 0x1.998p-4F, "0.1 rounds to the nearest half");
static_assert(!is_finite_half(to_half(1.0e9F)));
static_assert(is_finite_half(to_half(65504.0F)));

constexpr record_kinds every_field{
    .quad = quad_kind::segment,
    .paint = paint_kind::noise,
    .ends = cap::round,
    .page = atlas_page{0xbeef},
};
static_assert(pack(every_field) == 0xbeef'00a2U);
static_assert(unpack_kinds(pack(every_field)) == every_field);
static_assert(!unpack_kinds(0x0000'0005U).has_value(), "no quad kind 5");
static_assert(!unpack_kinds(0x0000'0030U).has_value(), "no paint kind 3");
static_assert(!unpack_kinds(0x0000'0100U).has_value(), "reserved bits are zero");

static_assert(packed({.r = 0x11, .g = 0x22, .b = 0x33, .a = 0x44}) == 0x4433'2211U, "red lowest");

static_assert(reach(0.0F) == 1.0F, "a crisp edge still needs its antialiased pixel");
static_assert(reach(2.0F) == 7.0F);

}
}
