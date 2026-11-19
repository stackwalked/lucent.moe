#include "../src/late_modules.hpp"

#include <array>
#include <bit>
#include <chrono>
#include <cstddef>
#include <filesystem>
#include <span>
#include <stop_token>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

// A set keyed by a module that isn't loaded at boot waits, and applies once the module loads. This
// test binary stands in for a module that "loads" between boot and a later scan; the late fixture
// DLL is loaded for real while the late worker waits on the loader's notification.

namespace lucent::kit {
namespace {

constexpr u8 late_module = 4;
constexpr u8 fixture_module = 5;

LUCENT_FACT fact::value<i32> late_count{"late_count", late_module, {.min = 0, .max = 64}};
LUCENT_FACT fact::value<i32> late_limit{"late_limit", late_module, {.min = 0, .max = 64}};
LUCENT_FACT fact::value<i32> fixture_count{"fixture_count", fixture_module, {.min = 0, .max = 64}};

using late_capability = capability<late_count>;
using fixture_capability = capability<fixture_count>;

auto trusted_signer() -> crypto::signing_key {
    crypto::seed material{};
    material.fill(std::byte{0x33});
    return crypto::signing_key::from_seed(material);
}

auto self() -> loaded_module {
    const result<module_image> image =
        image_at(late_module, std::bit_cast<uptr>(GetModuleHandleW(nullptr)));
    REQUIRE(image.has_value());
    return loaded_module{
        .build =
            bundle::module_key{
                .name_hash = module_name_hash("lucent_kit_tests.exe"),
                .time_date_stamp = image->time_date_stamp,
                .size_of_image = image->size_of_image,
            },
        .image = *image,
    };
}

auto bundle_for(const bundle::module_key& build, std::vector<bundle::entry> entries)
    -> std::vector<std::byte> {
    bundle::fact_set_header header;
    header.revision = 1;
    header.modules = {build};
    header.manifest_digest = manifest_of(linked_fact_records());
    const bundle::fact_set set =
        bundle::sign_fact_set(std::move(header), std::move(entries), trusted_signer());
    return bundle::encode_bundle(std::array{bundle::deliver_all(set)});
}

// The boot resolve, with no game module loaded yet.
auto apply_at_boot(std::span<const std::byte> bundle) -> apply_report {
    const std::array<crypto::public_key, 1> trusted{trusted_signer().public_part()};
    result<apply_report> report = apply(
        apply_request{
            .bundle = bundle,
            .trusted = trusted,
            .records = linked_fact_records(),
            .modules = {},
        }
    );
    REQUIRE(report.has_value());
    return *std::move(report);
}

auto apply_late(waiting_sets& waiting, const loaded_module& loaded) -> late_report {
    const std::array modules{loaded};
    return waiting.apply_loaded(late_request{.records = linked_fact_records(), .modules = modules});
}

auto honest_bundle() -> std::vector<std::byte> {
    return bundle_for(
        self().build,
        {
            bundle::literal(late_count.record().key, 7),
            bundle::literal(late_limit.record().key, 65),
        }
    );
}

TEST_CASE("a set keyed by a module that isn't loaded at boot waits, its capability unavailable") {
    const apply_report booted = apply_at_boot(honest_bundle());

    CHECK(booted.sets == std::vector{set_outcome::module_absent});
    CHECK_FALSE(booted.waiting.is_empty());
    CHECK_FALSE(is_available(late_capability{}));
}

TEST_CASE("a waiting set resolves its facts with their checks once its module has loaded") {
    apply_report booted = apply_at_boot(honest_bundle());

    const late_report late = apply_late(booted.waiting, self());

    CHECK(late.sets == std::vector{set_outcome::applied});
    CHECK(booted.waiting.is_empty());
    CHECK(is_available(late_capability{}));
    CHECK(late_count.get() == 7);
    // 65 is outside late_limit's range: the value kind's check ran on the late module's fact.
    CHECK(late_limit.record().status == fact_status::rejected);
    CHECK(late.facts.resolved == 1);
    CHECK(late.facts.rejected == 1);
}

TEST_CASE("a waiting set whose module loads as another build is dropped, leaving it unavailable") {
    bundle::module_key other_build = self().build;
    ++other_build.time_date_stamp;
    apply_report booted =
        apply_at_boot(bundle_for(other_build, {bundle::literal(late_count.record().key, 7)}));

    const late_report late = apply_late(booted.waiting, self());

    CHECK(late.sets == std::vector{set_outcome::other_build});
    CHECK(booted.waiting.is_empty());
    CHECK_FALSE(is_available(late_capability{}));
    CHECK(late_count.record().status == fact_status::unresolved);
}

TEST_CASE("a waiting set stays waiting while its module isn't loaded") {
    apply_report booted = apply_at_boot(honest_bundle());

    const late_report late =
        booted.waiting.apply_loaded(late_request{.records = linked_fact_records(), .modules = {}});

    CHECK(late.sets.empty());
    CHECK_FALSE(booted.waiting.is_empty());
    CHECK_FALSE(is_available(late_capability{}));
}

auto fixture_path() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_FIXTURE_LATE};
}

auto fixture_name() -> std::string {
    return fixture_path().filename().string();
}

// The fixture's build key from its file, as the generator would read it.
auto fixture_build() -> bundle::module_key {
    const result<std::vector<std::byte>> file = os::read_file(fixture_path());
    REQUIRE(file.has_value());
    const result<pe::image_view> view = pe::image_view::parse(*file, pe::layout::file);
    REQUIRE(view.has_value());
    const result<bundle::module_key> build = module_build_of(*view, fixture_name());
    REQUIRE(build.has_value());
    return *build;
}

auto wait_until_available() -> bool {
    const monotonic_clock real_time;
    const clock::time_point deadline = real_time.now() + std::chrono::seconds{10};
    while (!is_available(fixture_capability{})) {
        if (real_time.now() > deadline) {
            return false;
        }
        std::this_thread::yield();
    }
    return true;
}

// Starts the late worker the way the lifecycle does.
auto start_late_worker(
    worker_set& workers, const detail::load_signal& signal, detail::late_facts late
) -> result<void> {
    return workers.start<"late facts">(
        [&signal, waiting = std::move(late)](const std::stop_token& stop) mutable {
            detail::resolve_late_modules(stop, signal, std::move(waiting));
        }
    );
}

TEST_CASE("the late worker resolves a module's facts when the loader loads it") {
    REQUIRE(GetModuleHandleW(fixture_path().filename().c_str()) == nullptr);
    const result<detail::load_signal> signal = detail::load_signal::watch();
    REQUIRE(signal.has_value());
    apply_report booted = apply_at_boot(
        bundle_for(fixture_build(), {bundle::literal(fixture_count.record().key, 3)})
    );
    const std::string name = fixture_name();
    const std::array known{game_module{.index = fixture_module, .name = name}};
    worker_set workers;
    const result<void> started = start_late_worker(
        workers,
        *signal,
        detail::late_facts{
            .waiting = std::move(booted.waiting),
            .modules = known,
            .records = linked_fact_records(),
        }
    );
    REQUIRE(started.has_value());
    CHECK_FALSE(is_available(fixture_capability{}));

    const HMODULE fixture = LoadLibraryW(fixture_path().c_str());
    REQUIRE(fixture != nullptr);
    const bool is_resolved = wait_until_available();
    CHECK(workers.stop().empty());
    FreeLibrary(fixture);

    CHECK(is_resolved);
    CHECK(fixture_count.get() == 3);
}

}
}
