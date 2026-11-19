#include <lucent/kit/hook.hpp>

#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <optional>
#include <stop_token>
#include <thread>
#include <tuple>
#include <utility>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/worker_set.hpp>

// Hooks real functions of this test process. The targets are optnone so the compiler neither
// inlines them nor folds their results into the callers: every call below reaches the patched
// bytes.

namespace lucent::kit {
namespace {

[[clang::optnone]] auto tripled(i32 value) -> i32 {
    i32 product = 0;
    for (i32 step = 0; step < 3; ++step) {
        product += value;
    }
    return product;
}

[[clang::optnone]] auto plus_three(i32 value) -> i32 {
    i32 moved = value;
    for (i32 step = 0; step < 3; ++step) {
        ++moved;
    }
    return moved;
}

using i32_call = hook_access<i32(i32)>;

auto tripled_plus_hundred(const i32_call& call, i32 value) -> i32 {
    return call.original(value) + 100;
}

auto plus_three_negated(const i32_call& call, i32 value) -> i32 {
    return -call.original(value);
}

// Set by a test for its length, read by the blocking handler on another thread.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the handler's only way to reach its test.
constinit HANDLE release_handler = nullptr;
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): see release_handler.
constinit std::atomic<bool> handler_entered{false};

auto tripled_after_release(const i32_call& call, i32 value) -> i32 {
    handler_entered.store(true, std::memory_order_release);
    WaitForSingleObject(release_handler, INFINITE);
    return call.original(value);
}

// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables): hook slots are constinit globals by design.
constinit hook_slot<i32(i32)> tripled_slot{&tripled_plus_hundred};
constinit hook_slot<i32(i32)> plus_three_slot{&plus_three_negated};
constinit hook_slot<i32(i32)> blocking_slot{&tripled_after_release};
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables)

auto address_of(i32 (*function)(i32)) -> uptr {
    return std::bit_cast<uptr>(function);
}

TEST_CASE("a hooked function runs its handler, which can call the original, until removed") {
    {
        const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
        const result<hook_set> hooks = hook_set::install(requests);
        REQUIRE(hooks.has_value());

        CHECK(tripled(2) == 106);
    }

    CHECK(tripled(2) == 6);
}

TEST_CASE("install hooks nothing when one of its targets can't be hooked") {
    // 0x06 is no instruction in 64-bit mode, so the second target can't be decoded or relocated.
    std::array<u8, 64> garbage{};
    garbage.fill(0x06);
    const std::array requests{
        hook_on<plus_three_slot>(address_of(&plus_three)),
        hook_on<tripled_slot>(std::bit_cast<uptr>(garbage.data())),
    };

    const result<hook_set> hooks = hook_set::install(requests);

    CHECK_FALSE(hooks.has_value());
    CHECK(plus_three(2) == 5);
}

TEST_CASE("removing hooks waits for calls still inside a detour") {
    release_handler = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    REQUIRE(release_handler != nullptr);
    handler_entered.store(false, std::memory_order_release);
    const std::array requests{hook_on<blocking_slot>(address_of(&tripled))};
    std::optional<hook_set> hooks;
    {
        result<hook_set> installed = hook_set::install(requests);
        REQUIRE(installed.has_value());
        hooks.emplace(std::move(*installed));
    }
    std::atomic<i32> caller_result{0};
    std::jthread caller{[&] { caller_result.store(tripled(2), std::memory_order_release); }};
    while (!handler_entered.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    std::atomic<bool> removed{false};
    std::jthread remover{[&] {
        hooks.reset();
        removed.store(true, std::memory_order_release);
    }};

    std::this_thread::sleep_for(std::chrono::milliseconds{200});
    const bool removed_while_in_flight = removed.load(std::memory_order_acquire);
    SetEvent(release_handler);
    caller.join();
    remover.join();
    CloseHandle(release_handler);
    release_handler = nullptr;

    CHECK_FALSE(removed_while_in_flight);
    CHECK(removed.load(std::memory_order_acquire));
    CHECK(caller_result.load(std::memory_order_acquire) == 6);
    CHECK(tripled(2) == 6);
}

// Stands in for a thread caught between a detour's first instruction and its in-flight count: it
// runs in this image without being counted.
auto spin(const std::atomic<bool>& stop) -> void {
    while (!stop.load(std::memory_order_relaxed)) {
        std::atomic_signal_fence(std::memory_order_seq_cst);
    }
}

TEST_CASE("removal waits while another thread runs in this module's code, uncounted") {
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    result<hook_set> hooks = hook_set::install(requests);
    REQUIRE(hooks.has_value());
    std::atomic<bool> stop{false};
    std::jthread spinner{[&] { spin(stop); }};
    std::atomic<bool> removed{false};
    std::jthread remover{[&] {
        std::ignore = hooks->remove(unhook_patience);
        removed.store(true, std::memory_order_release);
    }};

    std::this_thread::sleep_for(std::chrono::milliseconds{200});
    const bool removed_while_spinning = removed.load(std::memory_order_acquire);
    stop.store(true, std::memory_order_relaxed);
    spinner.join();
    remover.join();

    CHECK_FALSE(removed_while_spinning);
    CHECK(removed.load(std::memory_order_acquire));
    CHECK(tripled(2) == 6);
}

TEST_CASE("removal gives up after its patience, leaving the target unpatched") {
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    result<hook_set> hooks = hook_set::install(requests);
    REQUIRE(hooks.has_value());
    std::atomic<bool> stop{false};
    std::jthread spinner{[&] { spin(stop); }};

    const result<void> removed = hooks->remove(std::chrono::milliseconds{100});
    stop.store(true, std::memory_order_relaxed);
    spinner.join();

    REQUIRE_FALSE(removed.has_value());
    CHECK(removed.error().code == error_code::timed_out);
    CHECK(tripled(2) == 6);
}

// An object laid out by hand as the game lays out one with virtuals: a pointer to its vtable, which
// follows an RTTI locator and holds code pointers until the first that isn't one.
struct fake_object {
    uptr vtable = 0;
};

[[clang::noinline, clang::optnone]] auto plus_one(fake_object* /*self*/, i32 value) -> i32 {
    return value + 1;
}

[[clang::noinline, clang::optnone]] auto times_ten(fake_object* /*self*/, i32 value) -> i32 {
    return value * 10;
}

using slot_call = hook_access<i32(fake_object*, i32)>;

auto doubled(const slot_call& call, fake_object* self, i32 value) -> i32 {
    return call.original(self, value) * 2;
}

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): hook slots are constinit globals by design.
constinit hook_slot<i32(fake_object*, i32)> doubled_slot{&doubled};

constexpr uptr fake_locator = 0x1234;

// A locator, two entries and the end of the run.
struct fake_vtable {
    std::array<uptr, 4> words{};
};

// Where an object's vtable pointer points: past the locator.
auto address_of(const fake_vtable& table) -> uptr {
    return std::bit_cast<uptr>(table.words.data()) + sizeof(uptr);
}

auto make_vtable() -> fake_vtable {
    return fake_vtable{
        .words = {
            fake_locator,
            std::bit_cast<uptr>(&plus_one),
            std::bit_cast<uptr>(&times_ten),
            0,
        },
    };
}

auto code_pointer_at(uptr address) -> uptr {
    const result<uptr> held = foreign::read(
        foreign::memory_source::this_process(), foreign::foreign_ptr<uptr>{.address = address}
    );
    REQUIRE(held.has_value());
    return *held;
}

// What every call below passes: plus_one makes it 5, times_ten 40, and doubled doubles either.
constexpr i32 argument = 4;

// A call the game makes through an object's vtable, which no compiler can devirtualize.
auto call_slot(fake_object& object, isize index) -> i32 {
    const uptr entry = code_pointer_at(object.vtable + (static_cast<uptr>(index) * sizeof(uptr)));
    return std::bit_cast<i32 (*)(fake_object*, i32)>(entry)(&object, argument);
}

auto object_request(const fake_object& object, uptr vtable, isize slot) -> object_hook_request {
    return object_hook_request{
        .object = std::bit_cast<uptr>(&object),
        .vtable = vtable,
        .slots = {hook_on_slot<doubled_slot>(slot)},
    };
}

TEST_CASE("an object hook routes the object's calls through a shadow, the real vtable untouched") {
    const fake_vtable real = make_vtable();
    fake_object hooked{.vtable = address_of(real)};
    fake_object bystander{.vtable = address_of(real)};
    const std::array objects{object_request(hooked, address_of(real), 0)};
    {
        const result<hook_set> hooks = hook_set::install({}, objects);
        REQUIRE(hooks.has_value());

        CHECK(call_slot(hooked, 0) == 10);
        CHECK(call_slot(hooked, 1) == 40);
        CHECK(call_slot(bystander, 0) == 5);
        CHECK(hooked.vtable != address_of(real));
        CHECK(code_pointer_at(hooked.vtable - sizeof(uptr)) == fake_locator);
        CHECK(real.words[1] == std::bit_cast<uptr>(&plus_one));
    }

    CHECK(hooked.vtable == address_of(real));
    CHECK(call_slot(hooked, 0) == 5);
}

TEST_CASE(
    "removal leaves a vtable pointer something else replaced, its shadow calling the real code"
) {
    const fake_vtable real = make_vtable();
    const fake_vtable replacement = make_vtable();
    fake_object hooked{.vtable = address_of(real)};
    const std::array objects{object_request(hooked, address_of(real), 0)};
    result<hook_set> hooks = hook_set::install({}, objects);
    REQUIRE(hooks.has_value());
    // Another hook in the game chains to ours: it keeps our shadow and points the object elsewhere.
    fake_object chained{.vtable = hooked.vtable};
    hooked.vtable = address_of(replacement);

    REQUIRE(hooks->remove(unhook_patience).has_value());

    CHECK(hooked.vtable == address_of(replacement));
    CHECK(call_slot(chained, 0) == 5);
}

TEST_CASE("an object whose vtable isn't its class's is refused, and nothing is hooked") {
    const fake_vtable real = make_vtable();
    const fake_vtable other = make_vtable();
    const fake_object hooked{.vtable = address_of(real)};
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    const std::array objects{object_request(hooked, address_of(other), 0)};

    const result<hook_set> hooks = hook_set::install(requests, objects);

    CHECK_FALSE(hooks.has_value());
    CHECK(tripled(2) == 6);
    CHECK(hooked.vtable == address_of(real));
}

TEST_CASE("an object hook on a slot past its vtable's end is refused") {
    const fake_vtable real = make_vtable();
    const fake_object hooked{.vtable = address_of(real)};
    const std::array objects{object_request(hooked, address_of(real), 2)};

    CHECK_FALSE(hook_set::install({}, objects).has_value());
    CHECK(hooked.vtable == address_of(real));
}

TEST_CASE("a hook whose vtable entry isn't its target is refused; one that is installs") {
    const std::array<uptr, 1> holding_tripled{address_of(&tripled)};
    const std::array<uptr, 1> holding_other{address_of(&plus_three)};
    hook_request matching = hook_on<tripled_slot>(address_of(&tripled));
    matching.check = entry_check{
        .entry = std::bit_cast<uptr>(holding_tripled.data()),
        .holds = address_of(&tripled),
    };
    hook_request moved = matching;
    moved.check = entry_check{
        .entry = std::bit_cast<uptr>(holding_other.data()),
        .holds = address_of(&tripled),
    };

    CHECK_FALSE(hook_set::install(std::array{moved}).has_value());
    CHECK(tripled(2) == 6);
    {
        const result<hook_set> hooks = hook_set::install(std::array{matching});
        REQUIRE(hooks.has_value());
        CHECK(tripled(2) == 106);
    }
    CHECK(tripled(2) == 6);
}

// A kit worker's body running in this module's code until its set stops it.
auto spin_until_stopped(const std::stop_token& stop) -> void {
    while (!stop.stop_requested()) {
        std::atomic_signal_fence(std::memory_order_seq_cst);
    }
}

TEST_CASE("a running kit worker keeps hook removal busy until the worker set stops") {
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    result<hook_set> hooks = hook_set::install(requests);
    REQUIRE(hooks.has_value());
    worker_set workers;
    const result<void> started = workers.start<"spinner">(&spin_until_stopped);
    REQUIRE(started.has_value());
    std::atomic<bool> removed{false};
    std::jthread remover{[&] {
        std::ignore = hooks->remove(unhook_patience);
        removed.store(true, std::memory_order_release);
    }};

    std::this_thread::sleep_for(std::chrono::milliseconds{200});
    const bool removed_while_working = removed.load(std::memory_order_acquire);
    std::ignore = workers.stop();
    remover.join();

    CHECK_FALSE(removed_while_working);
    CHECK(removed.load(std::memory_order_acquire));
    CHECK(tripled(2) == 6);
}

// Hook requests from facts: a handler whose signature isn't the fact's fails to compile.
LUCENT_FACT fact::method<i32(fake_object*, i32)> hook_scaled_code{"hook_scaled_code", 1};
LUCENT_FACT fact::vtable<fake_object> hook_vtable{"hook_vtable", 1};
LUCENT_FACT fact::slot<i32(fake_object*, i32)> hook_scaled{"hook_scaled", 1, "hook_vtable"};
LUCENT_FACT fact::slot<i32(fake_object*)> hook_counted{"hook_counted", 1, "hook_vtable"};
LUCENT_FACT fact::method<i32(i32)> hook_plain_code{"hook_plain_code", 1};

template <auto& Slot, const auto& Method>
concept can_hook_method = requires { hook_on<Slot, Method>(); };

template <auto& Slot, const auto& Method, const auto& Vtable, const auto& Index>
concept can_hook_checked = requires { hook_on<Slot, Method, Vtable, Index>(); };

template <auto& Slot, const auto& Index>
concept can_hook_slot = requires { hook_on_slot<Slot, Index>(); };

static_assert(can_hook_method<doubled_slot, hook_scaled_code>);
static_assert(!can_hook_method<doubled_slot, hook_plain_code>);
static_assert(can_hook_method<tripled_slot, hook_plain_code>);
static_assert(can_hook_checked<doubled_slot, hook_scaled_code, hook_vtable, hook_scaled>);
static_assert(!can_hook_checked<doubled_slot, hook_scaled_code, hook_vtable, hook_counted>);
static_assert(can_hook_slot<doubled_slot, hook_scaled>);
static_assert(!can_hook_slot<doubled_slot, hook_counted>);
}
}
