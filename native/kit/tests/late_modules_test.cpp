#include "../src/late_modules.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <stop_token>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/match.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/unique_handle.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/session.hpp>

#include "../src/data_client.hpp"
#include "../src/frame_inbox.hpp"
#include "../src/random.hpp"
#include "../src/session_end.hpp"

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
auto start_late_worker(worker_set& workers, detail::late_worker handed) -> result<void> {
    return workers.start<"late facts">(
        [late = std::move(handed)](const std::stop_token& stop) mutable {
            detail::resolve_late_modules(stop, std::move(late));
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
        detail::late_worker{
            .signal = &*signal,
            .ending = nullptr,
            .data = nullptr,
            .facts = detail::late_facts{
                .waiting = std::move(booted.waiting),
                .waiting_core = {},
                .unasked = {},
                .modules = known,
                .records = linked_fact_records(),
                .trusted = {},
            },
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

auto wait_until_requested(const detail::session_end& ending) -> bool {
    const monotonic_clock real_time;
    const clock::time_point deadline = real_time.now() + std::chrono::seconds{10};
    while (!ending.is_requested()) {
        if (real_time.now() > deadline) {
            return false;
        }
        std::this_thread::yield();
    }
    return true;
}

// Stands in for the lifecycle thread blocked on the host; it holds no I/O to cancel.
auto idle_until_stopped(const std::stop_token& stop) -> void {
    while (!stop.stop_requested()) {
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
    }
}

auto handle_of(std::jthread& thread) -> os::unique_handle {
    HANDLE duplicated = nullptr;
    const BOOL is_duplicated = DuplicateHandle(
        GetCurrentProcess(),
        thread.native_handle(),
        GetCurrentProcess(),
        &duplicated,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS
    );
    REQUIRE(is_duplicated != FALSE);
    return os::unique_handle{duplicated};
}

// A core capability made of the fixture's one fact, waiting for the fixture to load.
auto fixture_core() -> std::vector<declared_capability> {
    return {
        declared_capability{
            .key = 0x5eed,
            .level = capability_level::core,
            .members = {fixture_count.record().key},
        },
    };
}

TEST_CASE("a core capability waiting for a module that loads without its facts ends the session") {
    REQUIRE(GetModuleHandleW(fixture_path().filename().c_str()) == nullptr);
    const result<detail::load_signal> signal = detail::load_signal::watch();
    REQUIRE(signal.has_value());
    // 65 is outside fixture_count's range: the set applies once the fixture loads, and is rejected.
    apply_report booted = apply_at_boot(
        bundle_for(fixture_build(), {bundle::literal(fixture_count.record().key, 65)})
    );
    const std::string name = fixture_name();
    const std::array known{game_module{.index = fixture_module, .name = name}};
    std::jthread lifecycle{&idle_until_stopped};
    detail::session_end ending{handle_of(lifecycle)};
    worker_set workers;
    const result<void> started = start_late_worker(
        workers,
        detail::late_worker{
            .signal = &*signal,
            .ending = &ending,
            .data = nullptr,
            .facts = detail::late_facts{
                .waiting = std::move(booted.waiting),
                .waiting_core = fixture_core(),
                .unasked = {},
                .modules = known,
                .records = linked_fact_records(),
                .trusted = {},
            },
        }
    );
    REQUIRE(started.has_value());
    std::this_thread::sleep_for(std::chrono::milliseconds{50});
    const bool ended_before_load = ending.is_requested();

    const HMODULE fixture = LoadLibraryW(fixture_path().c_str());
    REQUIRE(fixture != nullptr);
    const bool has_ended = wait_until_requested(ending);
    CHECK(workers.stop().empty());
    FreeLibrary(fixture);

    CHECK_FALSE(ended_before_load);
    CHECK(has_ended);
    CHECK(fixture_count.record().status == fact_status::rejected);
}

// Fills nothing in: the data route's nonces need no secrecy in a test, and stay the same each run.
class zero_random final : public detail::random_source {
public:
    auto fill(std::span<std::byte> out) -> result<void> override {
        std::ranges::fill(out, std::byte{0});
        return {};
    }
};

constexpr wire::session_id test_session{};

auto key_of(u8 fill) -> crypto::secret_key {
    std::array<std::byte, crypto::secret_key_size> material{};
    material.fill(std::byte{fill});
    return crypto::secret_key::from_bytes(material);
}

// The module's ends of two anonymous pipes, and the host's ends, as the host would hold them.
struct pipes {
    session_ends module;
    session_ends host;
};

auto pipe_pair() -> pipes {
    HANDLE to_module_read = nullptr;
    HANDLE to_module_write = nullptr;
    HANDLE to_host_read = nullptr;
    HANDLE to_host_write = nullptr;
    REQUIRE(CreatePipe(&to_module_read, &to_module_write, nullptr, 0) != FALSE);
    REQUIRE(CreatePipe(&to_host_read, &to_host_write, nullptr, 0) != FALSE);
    return pipes{
        .module =
            session_ends{
                .inbound = os::unique_handle{to_module_read},
                .outbound = os::unique_handle{to_host_write},
            },
        .host = session_ends{
            .inbound = os::unique_handle{to_host_read},
            .outbound = os::unique_handle{to_module_write},
        },
    };
}

// The server's answer to one data request, sealed as platform/server would seal it.
auto data_reply(std::span<const std::byte> bundle) -> std::vector<std::byte> {
    const std::vector<std::byte> plain = wire::encode_data_response(
        wire::data_response{
            .answers = 0,
            .data_revision = 0,
            .bundle_bytes = std::vector<std::byte>{bundle.begin(), bundle.end()},
            .unsupported = {},
        }
    );
    return wire::encode_frame(
        wire::seal_frame(
            key_of(2),
            wire::frame_contents{
                .header =
                    wire::frame_header{
                        .session = test_session,
                        .way = wire::direction::server_to_module,
                        .sequence = 1,
                    },
                .nonce = {},
                .plain = plain,
            }
        )
    );
}

// What the module asked the server for, as the host relays it.
auto asked_modules(session& host) -> std::vector<bundle::module_key> {
    const result<session_message> received = host.receive();
    REQUIRE(received.has_value());
    const result<std::vector<std::byte>> body = match(
        *received,
        [](const server_request& asked) -> result<std::vector<std::byte>> {
            if (asked.route != server_route::data) {
                return std::unexpected(error{.code = error_code::malformed});
            }
            return asked.body;
        },
        [](const auto&) -> result<std::vector<std::byte>> {
            return std::unexpected(error{.code = error_code::malformed});
        }
    );
    REQUIRE(body.has_value());
    const result<wire::frame> sealed = wire::decode_frame(*body);
    REQUIRE(sealed.has_value());
    const result<crypto::secret_bytes> plain = wire::open_frame(key_of(1), *sealed);
    REQUIRE(plain.has_value());
    const result<wire::data_request> request = wire::decode_data_request(plain->as_bytes());
    REQUIRE(request.has_value());
    return request->modules;
}

TEST_CASE("a module that loads after the start gets its set from the server's data reply") {
    REQUIRE(GetModuleHandleW(fixture_path().filename().c_str()) == nullptr);
    const result<detail::load_signal> signal = detail::load_signal::watch();
    REQUIRE(signal.has_value());
    // Every fact unresolved, as at a boot that had no set for the fixture.
    std::ignore = apply_at_boot(honest_bundle());
    const std::string name = fixture_name();
    const std::array known{game_module{.index = fixture_module, .name = name}};
    const std::array<crypto::public_key, 1> trusted{trusted_signer().public_part()};
    pipes ends = pipe_pair();
    session channel{std::move(ends.module)};
    session host{std::move(ends.host)};
    wire::route_keys keys{.module_to_server = key_of(1), .server_to_module = key_of(2)};
    detail::data_client client{test_session, std::move(keys)};
    detail::frame_inbox inbox;
    const monotonic_clock real_time;
    zero_random random;
    const detail::data_link link{
        .client = &client,
        .inbox = &inbox,
        .channel = &channel,
        .time = &real_time,
        .random = &random,
    };
    worker_set workers;
    const result<void> started = start_late_worker(
        workers,
        detail::late_worker{
            .signal = &*signal,
            .ending = nullptr,
            .data = &link,
            .facts = detail::late_facts{
                .waiting = {},
                .waiting_core = {},
                .unasked = {fixture_module},
                .modules = known,
                .records = linked_fact_records(),
                .trusted = trusted,
            },
        }
    );
    REQUIRE(started.has_value());

    const HMODULE fixture = LoadLibraryW(fixture_path().c_str());
    REQUIRE(fixture != nullptr);
    const std::vector<bundle::module_key> asked = asked_modules(host);
    inbox.push(
        data_reply(bundle_for(fixture_build(), {bundle::literal(fixture_count.record().key, 5)}))
    );
    const bool is_resolved = wait_until_available();
    CHECK(workers.stop().empty());
    FreeLibrary(fixture);

    CHECK(asked == std::vector{fixture_build()});
    CHECK(is_resolved);
    CHECK(fixture_count.get() == 5);
}

}
}
