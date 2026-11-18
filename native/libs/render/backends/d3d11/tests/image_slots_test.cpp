#include "../src/image_slots.hpp"

#include <optional>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/image_quad.hpp>

namespace lucent::d3d11 {
namespace {

// Every test here allocates far below max_slots.
auto allocated(image_slots& slots) -> allocated_image {
    const std::optional<allocated_image> made = slots.allocate();
    LUCENT_INVARIANT(made.has_value());
    return *made;
}

TEST_CASE("a destroyed handle never finds its slot again, even once the slot is reused") {
    image_slots slots;
    const allocated_image first = allocated(slots);
    slots.release(first.image);

    const allocated_image second = allocated(slots);

    CHECK(second.slot == first.slot);
    CHECK(second.image != first.image);
    CHECK(slots.slot_of(first.image) == std::nullopt);
    CHECK(slots.slot_of(second.image) == second.slot);
}

TEST_CASE("a handle from another renderer never matches a slot of this one") {
    image_slots earlier;
    image_slots later;
    const allocated_image old = allocated(earlier);
    const allocated_image fresh = allocated(later);

    CHECK(old.slot == fresh.slot);
    CHECK(old.image != fresh.image);
    CHECK(later.slot_of(old.image) == std::nullopt);
}

TEST_CASE("releasing a stale handle frees nothing") {
    image_slots slots;
    const allocated_image first = allocated(slots);
    slots.release(first.image);
    const allocated_image second = allocated(slots);

    slots.release(first.image);

    CHECK(slots.slot_of(second.image) == second.slot);
}

TEST_CASE("the zero handle names no image") {
    image_slots slots;
    const allocated_image made = allocated(slots);

    CHECK(made.slot == 0);
    CHECK(slots.slot_of(draw::image_handle{}) == std::nullopt);
}

}
}
