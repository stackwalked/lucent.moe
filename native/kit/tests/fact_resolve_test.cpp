#include <lucent/kit/fact_resolve.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <span>
#include <tuple>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// Resolves this test binary's own linked facts against this test binary's own image, standing in
// for a game module: real functions, data, a vtable and .pdata.

namespace lucent::kit {
namespace {

constexpr u8 test_module = 1;

// optnone: at /O2 the loop folds to a closed-form leaf with no unwind data, which resolve rightly
// accepts at any address; the rejection test needs a function .pdata describes.
[[clang::noinline, clang::optnone]] auto probe_function(i32 input) -> i32 {
    i32 total = 0;
    for (i32 step = 0; step < input; ++step) {
        total += step;
    }
    return total;
}

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): data at a known address in this image.
constinit u64 probe_data = 7;

class probe_base {
public:
    probe_base() = default;
    probe_base(const probe_base&) = delete ("a vtable sample, never copied");
    auto operator=(const probe_base&) -> probe_base& = delete ("never copied");
    probe_base(probe_base&&) = delete ("never moved");
    auto operator=(probe_base&&) -> probe_base& = delete ("never moved");
    virtual ~probe_base() = default;

    virtual auto first() -> i32 {
        return 1;
    }

    virtual auto second() -> i32 {
        return 2;
    }
};

struct probe_owner {
    u32 small;
    u64 large;
};

LUCENT_FACT fact::method<i32(i32)> probe_method{"probe_method", test_module};
LUCENT_FACT fact::global<u64> probe_global{"probe_global", test_module};
LUCENT_FACT fact::vtable<probe_base> probe_vtable{"probe_vtable", test_module};
LUCENT_FACT fact::slot<i32(probe_base*)> probe_slot{"probe_slot", test_module, "probe_vtable"};
LUCENT_FACT fact::value<i32> probe_owner_size{
    "probe_owner_size",
    test_module,
    {.min = 0, .max = 4096},
};
LUCENT_FACT fact::field<probe_owner, u64> probe_large{
    "probe_large",
    test_module,
    "probe_owner_size",
};
LUCENT_FACT fact::value<i32> probe_count{"probe_count", test_module, {.min = 0, .max = 64}};

using value_set = std::array<fact_value, 7>;

auto self() -> module_image {
    const result<module_image> image =
        image_at(test_module, std::bit_cast<uptr>(GetModuleHandleW(nullptr)));
    REQUIRE(image.has_value());
    return *image;
}

auto rva_of(const module_image& image, uptr address) -> u64 {
    return address - image.base;
}

// An object with virtuals starts with its vtable pointer (MSVC x64 ABI).
auto vtable_rva(const module_image& image) -> u64 {
    const probe_base sample;
    std::array<std::byte, sizeof(uptr)> head{};
    std::ranges::copy(std::as_bytes(std::span{&sample, 1}).first<sizeof(uptr)>(), head.begin());
    return rva_of(image, std::bit_cast<uptr>(head));
}

// Every fact given a value that passes its check.
auto good_values(const module_image& image) -> value_set {
    return {
        fact_value{
            .key = probe_method.record().key,
            .value = rva_of(image, std::bit_cast<uptr>(&probe_function)),
        },
        fact_value{
            .key = probe_global.record().key,
            .value = rva_of(image, std::bit_cast<uptr>(&probe_data)),
        },
        fact_value{.key = probe_vtable.record().key, .value = vtable_rva(image)},
        fact_value{.key = probe_slot.record().key, .value = 2},
        fact_value{.key = probe_owner_size.record().key, .value = sizeof(probe_owner)},
        fact_value{.key = probe_large.record().key, .value = offsetof(probe_owner, large)},
        fact_value{.key = probe_count.record().key, .value = 10},
    };
}

// The set with one fact's value replaced.
auto with(value_set values, const auto& typed, u64 value) -> value_set {
    const auto found = std::ranges::find(values, typed.record().key, &fact_value::key);
    REQUIRE(found != values.end());
    found->value = value;
    return values;
}

// The set with one fact's value taken out.
auto without(value_set values, const auto& typed) -> value_set {
    const auto found = std::ranges::find(values, typed.record().key, &fact_value::key);
    REQUIRE(found != values.end());
    found->key = 0;
    return values;
}

auto resolve_with(const module_image& image, std::span<const fact_value> values) -> resolve_report {
    const std::array modules{image};
    return resolve(linked_fact_records(), values, modules);
}

auto status_after(const module_image& image, const value_set& values, const auto& typed)
    -> fact_status {
    std::ignore = resolve_with(image, values);
    return typed.record().status;
}

TEST_CASE("values that pass their kind's check resolve, as addresses for the address kinds") {
    const module_image image = self();

    const resolve_report report = resolve_with(image, good_values(image));

    CHECK(report.rejected == 0);
    CHECK(report.resolved >= 7);
    CHECK(probe_method.address() == std::bit_cast<uptr>(&probe_function));
    CHECK(probe_global.address() == std::bit_cast<uptr>(&probe_data));
    CHECK(probe_slot.index() == 2);
    CHECK(probe_large.offset() == 8);
    CHECK(probe_count.get() == 10);
}

TEST_CASE("an address inside a function, or a function in data, is rejected as a method") {
    const module_image image = self();
    const u64 function = rva_of(image, std::bit_cast<uptr>(&probe_function));
    const u64 data = rva_of(image, std::bit_cast<uptr>(&probe_data));
    // Without unwind data no address in the function is known not to start one, and +1 passes.
    DWORD64 function_table_base = 0;
    REQUIRE(
        RtlLookupFunctionEntry(
            std::bit_cast<DWORD64>(&probe_function), &function_table_base, nullptr
        )
        != nullptr
    );

    CHECK(
        status_after(image, with(good_values(image), probe_method, function + 1), probe_method)
        == fact_status::rejected
    );
    CHECK(
        status_after(image, with(good_values(image), probe_method, data), probe_method)
        == fact_status::rejected
    );
}

TEST_CASE("a global in code or off its alignment is rejected") {
    const module_image image = self();
    const u64 function = rva_of(image, std::bit_cast<uptr>(&probe_function));
    const u64 data = rva_of(image, std::bit_cast<uptr>(&probe_data));

    CHECK(
        status_after(image, with(good_values(image), probe_global, function), probe_global)
        == fact_status::rejected
    );
    CHECK(
        status_after(image, with(good_values(image), probe_global, data + 1), probe_global)
        == fact_status::rejected
    );
}

TEST_CASE("a vtable in writable data is rejected, and its slots with it") {
    const module_image image = self();
    const u64 data = rva_of(image, std::bit_cast<uptr>(&probe_data));

    std::ignore = resolve_with(image, with(good_values(image), probe_vtable, data));

    CHECK(probe_vtable.record().status == fact_status::rejected);
    CHECK(probe_slot.record().status == fact_status::rejected);
}

TEST_CASE("a slot past its vtable's length is rejected") {
    const module_image image = self();

    CHECK(
        status_after(image, with(good_values(image), probe_slot, 4000), probe_slot)
        == fact_status::rejected
    );
}

TEST_CASE("a field off its alignment or past its owner's size is rejected") {
    const module_image image = self();

    CHECK(
        status_after(image, with(good_values(image), probe_large, 12), probe_large)
        == fact_status::rejected
    );
    CHECK(
        status_after(image, with(good_values(image), probe_large, 16), probe_large)
        == fact_status::rejected
    );
}

TEST_CASE("a field whose owner's size didn't resolve is rejected") {
    const module_image image = self();

    std::ignore = resolve_with(image, without(good_values(image), probe_owner_size));

    CHECK(probe_owner_size.record().status == fact_status::unresolved);
    CHECK(probe_large.record().status == fact_status::rejected);
}

TEST_CASE("a value outside its range is rejected, below it as much as above") {
    const module_image image = self();
    const auto below = static_cast<u64>(i64{-1});

    CHECK(
        status_after(image, with(good_values(image), probe_count, 65), probe_count)
        == fact_status::rejected
    );
    CHECK(
        status_after(image, with(good_values(image), probe_count, below), probe_count)
        == fact_status::rejected
    );
}

TEST_CASE("a value for a fact this image doesn't link is counted, and changes nothing") {
    const module_image image = self();
    const std::array values{fact_value{.key = 0x1234'5678, .value = 1}};

    const resolve_report report = resolve_with(image, values);

    CHECK(report.unknown == 1);
    CHECK(report.resolved == 0);
    CHECK(probe_count.record().status == fact_status::unresolved);
}

TEST_CASE("a capability is available only while every fact in it resolved") {
    const module_image image = self();
    using sizing = capability<probe_owner_size, probe_large>;

    std::ignore = resolve_with(image, good_values(image));
    const bool is_available_with_all = is_available(sizing{});
    std::ignore = resolve_with(image, with(good_values(image), probe_large, 16));
    const bool is_available_with_one_rejected = is_available(sizing{});

    CHECK(is_available_with_all);
    CHECK_FALSE(is_available_with_one_rejected);
}

}
}
