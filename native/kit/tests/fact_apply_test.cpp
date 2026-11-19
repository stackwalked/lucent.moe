#include <lucent/kit/fact_apply.hpp>

#include <array>
#include <bit>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

// Applies bundles made with the real bundle format and real signatures to this test binary's own
// linked facts, with this test binary standing in for the game module they're keyed by. The keys
// come from fixed seeds, never from a machine's dev key.

namespace lucent::kit {
namespace {

constexpr u8 test_module = 1;
constexpr u8 unkeyed_module = 2;

LUCENT_FACT fact::value<i32> bundled_count{"bundled_count", test_module, {.min = 0, .max = 64}};
LUCENT_FACT fact::value<i32> unkeyed_count{"unkeyed_count", unkeyed_module, {.min = 0, .max = 64}};

static_assert(module_name_hash("Client.DLL") == module_name_hash("client.dll"));
static_assert(module_name_hash("client.dll") != module_name_hash("engine2.dll"));

auto signer_from(u8 fill) -> crypto::signing_key {
    crypto::seed material{};
    material.fill(std::byte{fill});
    return crypto::signing_key::from_seed(material);
}

auto trusted_signer() -> crypto::signing_key {
    return signer_from(0x11);
}

auto untrusted_signer() -> crypto::signing_key {
    return signer_from(0x22);
}

auto self() -> loaded_module {
    const result<module_image> image =
        image_at(test_module, std::bit_cast<uptr>(GetModuleHandleW(nullptr)));
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

auto header_for(const bundle::module_key& build, const crypto::digest& manifest)
    -> bundle::fact_set_header {
    bundle::fact_set_header header;
    header.revision = 1;
    header.modules = {build};
    header.manifest_digest = manifest;
    return header;
}

// A set made for this image, as devkey or the generator would make it.
auto honest_header() -> bundle::fact_set_header {
    return header_for(self().build, manifest_of(linked_fact_records()));
}

auto signed_set(bundle::fact_set_header header, const crypto::signing_key& signer)
    -> bundle::fact_set {
    return bundle::sign_fact_set(
        std::move(header), {bundle::literal(bundled_count.record().key, 10)}, signer
    );
}

auto bytes_of(const bundle::delivered_set& set) -> std::vector<std::byte> {
    return bundle::encode_bundle(std::array{set});
}

auto apply_to_self(std::span<const std::byte> bundle) -> result<apply_report> {
    const std::array<crypto::public_key, 1> trusted{trusted_signer().public_part()};
    const std::array modules{self()};
    return apply(
        apply_request{
            .bundle = bundle,
            .trusted = trusted,
            .records = linked_fact_records(),
            .modules = modules,
        }
    );
}

auto outcome_of(const bundle::fact_set& set) -> set_outcome {
    const result<apply_report> report = apply_to_self(bytes_of(bundle::deliver_all(set)));
    REQUIRE(report.has_value());
    REQUIRE(report->sets.size() == 1);
    return report->sets.front();
}

// Resolves bundled_count first, so a refusal is seen to undo an earlier apply.
auto apply_honest_bundle() -> void {
    REQUIRE(outcome_of(signed_set(honest_header(), trusted_signer())) == set_outcome::applied);
    REQUIRE(bundled_count.record().status == fact_status::resolved);
}

TEST_CASE("a set signed by a trusted key for this manifest and module build resolves its facts") {
    const result<apply_report> report =
        apply_to_self(bytes_of(bundle::deliver_all(signed_set(honest_header(), trusted_signer()))));

    REQUIRE(report.has_value());
    CHECK(report->sets == std::vector{set_outcome::applied});
    CHECK(report->facts.resolved == 1);
    CHECK(report->misplaced == 0);
    CHECK(bundled_count.get() == 10);
}

TEST_CASE("a set signed by a key that isn't trusted is refused, leaving its facts unresolved") {
    apply_honest_bundle();

    CHECK(outcome_of(signed_set(honest_header(), untrusted_signer())) == set_outcome::unverified);
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

TEST_CASE("a set with an entry changed after signing is refused, leaving its facts unresolved") {
    apply_honest_bundle();
    bundle::delivered_set tampered =
        bundle::deliver_all(signed_set(honest_header(), trusted_signer()));
    tampered.entries.front().value = bundle::literal(bundled_count.record().key, 11);

    const result<apply_report> report = apply_to_self(bytes_of(tampered));

    REQUIRE(report.has_value());
    CHECK(report->sets == std::vector{set_outcome::unverified});
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

TEST_CASE("a set made for another manifest is refused, leaving its facts unresolved") {
    apply_honest_bundle();
    const bundle::fact_set_header header = header_for(self().build, crypto::hash({}));

    CHECK(outcome_of(signed_set(header, trusted_signer())) == set_outcome::other_manifest);
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

TEST_CASE(
    "a set keyed by another build of a loaded module is refused, leaving its facts unresolved"
) {
    apply_honest_bundle();
    bundle::module_key other_build = self().build;
    ++other_build.time_date_stamp;
    const bundle::fact_set_header header =
        header_for(other_build, manifest_of(linked_fact_records()));

    CHECK(outcome_of(signed_set(header, trusted_signer())) == set_outcome::other_build);
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

TEST_CASE("a set keyed by a module that isn't loaded applies nothing") {
    apply_honest_bundle();
    bundle::module_key absent = self().build;
    absent.name_hash = module_name_hash("absent.dll");
    const bundle::fact_set_header header = header_for(absent, manifest_of(linked_fact_records()));

    CHECK(outcome_of(signed_set(header, trusted_signer())) == set_outcome::module_absent);
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

TEST_CASE("a value for a fact of a module the set isn't keyed by is dropped") {
    const bundle::fact_set set = bundle::sign_fact_set(
        honest_header(),
        {
            bundle::literal(bundled_count.record().key, 10),
            bundle::literal(unkeyed_count.record().key, 5),
        },
        trusted_signer()
    );

    const result<apply_report> report = apply_to_self(bytes_of(bundle::deliver_all(set)));

    REQUIRE(report.has_value());
    CHECK(report->misplaced == 1);
    CHECK(bundled_count.record().status == fact_status::resolved);
    CHECK(unkeyed_count.record().status == fact_status::unresolved);
}

TEST_CASE("a bundle that doesn't decode fails, leaving every fact unresolved") {
    apply_honest_bundle();
    const std::array garbage{std::byte{0x4c}, std::byte{0x46}, std::byte{0x42}};

    const result<apply_report> report = apply_to_self(garbage);

    REQUIRE_FALSE(report.has_value());
    CHECK(report.error().code == error_code::malformed);
    CHECK(bundled_count.record().status == fact_status::unresolved);
}

auto own_path() -> std::filesystem::path {
    std::wstring path(32'768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(std::ssize(path)));
    REQUIRE(length > 0);
    path.resize(length);
    return path;
}

TEST_CASE("a module's build key reads the same from its file as from its loaded headers") {
    const result<std::vector<std::byte>> file = os::read_file(own_path());
    REQUIRE(file.has_value());
    const result<pe::image_view> view = pe::image_view::parse(*file, pe::layout::file);
    REQUIRE(view.has_value());

    const result<bundle::module_key> from_file = module_build_of(*view, "LUCENT_KIT_TESTS.EXE");

    REQUIRE(from_file.has_value());
    CHECK(*from_file == self().build);
}

}
}
