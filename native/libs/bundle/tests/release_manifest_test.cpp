#include <lucent/bundle/release_manifest.hpp>

#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>

// The refusals are made from bytes laid out by hand, so they state the wire format independently
// of the encoder, which refuses to write anything that isn't canonical.

namespace lucent::bundle {
namespace {

struct raw_capability {
    u64 key = 0;
    u8 level = 0;
    std::vector<u64> members;
};

struct raw_manifest {
    u32 magic = 0x314d'524c;
    u16 version = 1;
    u32 game = 730;
    std::vector<manifest_entry> facts;
    std::vector<raw_capability> capabilities;
};

// The low `Width` bytes of a value, little-endian.
template <usize Width>
auto little(u64 value) -> std::array<std::byte, Width> {
    std::array<std::byte, Width> bytes{};
    for (usize index = 0; index < Width; ++index) {
        bytes.at(index) = static_cast<std::byte>((value >> (8U * index)) & 0xffU);
    }
    return bytes;
}

auto bytes_of(const raw_manifest& raw) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.append_range(little<4>(raw.magic));
    out.append_range(little<2>(raw.version));
    out.append_range(little<4>(raw.game));
    out.append_range(little<4>(raw.facts.size()));
    for (const manifest_entry& fact : raw.facts) {
        out.append_range(little<8>(fact.key));
        out.append_range(little<1>(fact.kind));
    }
    out.append_range(little<4>(raw.capabilities.size()));
    for (const raw_capability& capability : raw.capabilities) {
        out.append_range(little<8>(capability.key));
        out.append_range(little<1>(capability.level));
        out.append_range(little<4>(capability.members.size()));
        for (const u64 member : capability.members) {
            out.append_range(little<8>(member));
        }
    }
    return out;
}

// Canonical: two facts, one core capability over both.
auto valid() -> raw_manifest {
    return raw_manifest{
        .facts = {manifest_entry{.key = 0x10, .kind = 1}, manifest_entry{.key = 0x20, .kind = 5}},
        .capabilities = {raw_capability{.key = 0xc1, .level = 1, .members = {0x10, 0x20}}},
    };
}

// Nothing when the bytes decode.
auto error_of(const raw_manifest& raw) -> std::optional<error_code> {
    const result<release_manifest> decoded = decode_release_manifest(bytes_of(raw));
    return decoded ? std::nullopt : std::optional{decoded.error().code};
}

TEST_CASE("a canonical release manifest decodes to what was laid out, and encodes back to it") {
    const std::vector<std::byte> bytes = bytes_of(valid());

    const result<release_manifest> decoded = decode_release_manifest(bytes);

    REQUIRE(decoded.has_value());
    CHECK(decoded->game == 730);
    CHECK(decoded->facts.size() == 2);
    REQUIRE(decoded->capabilities.size() == 1);
    CHECK(decoded->capabilities.front().level == capability_level::core);
    CHECK(encode_release_manifest(*decoded) == bytes);
}

TEST_CASE("the manifest digest is the fact set's, over the facts alone") {
    const result<release_manifest> decoded = decode_release_manifest(bytes_of(valid()));
    REQUIRE(decoded.has_value());
    release_manifest without_capabilities = *decoded;
    without_capabilities.capabilities.clear();

    CHECK(manifest_digest(*decoded) == manifest_digest(std::span{decoded->facts}));
    CHECK(manifest_digest(*decoded) == manifest_digest(without_capabilities));
}

TEST_CASE("the core facts are every core capability's members, once each, and no optional one's") {
    const release_manifest manifest{
        .game = 1,
        .facts =
            {
                manifest_entry{.key = 0x10, .kind = 0},
                manifest_entry{.key = 0x20, .kind = 0},
                manifest_entry{.key = 0x30, .kind = 0},
                manifest_entry{.key = 0x40, .kind = 0},
            },
        .capabilities = {
            manifest_capability{
                .key = 1,
                .level = capability_level::core,
                .members = {0x20, 0x30},
            },
            manifest_capability{
                .key = 2,
                .level = capability_level::optional,
                .members = {0x40},
            },
            manifest_capability{
                .key = 3,
                .level = capability_level::core,
                .members = {0x10, 0x30},
            },
        },
    };

    CHECK(core_fact_keys(manifest) == std::vector<u64>{0x10, 0x20, 0x30});
}

TEST_CASE("a manifest with unsorted or duplicate facts is malformed") {
    raw_manifest unsorted = valid();
    unsorted.facts = {
        manifest_entry{.key = 0x20, .kind = 5},
        manifest_entry{.key = 0x10, .kind = 1},
    };
    raw_manifest duplicate = valid();
    duplicate.facts = {
        manifest_entry{.key = 0x10, .kind = 1},
        manifest_entry{.key = 0x10, .kind = 1},
    };
    duplicate.capabilities.front().members = {0x10};

    CHECK(error_of(unsorted) == error_code::malformed);
    CHECK(error_of(duplicate) == error_code::malformed);
}

TEST_CASE("a capability member missing from the facts list is malformed") {
    raw_manifest missing = valid();
    missing.capabilities.front().members = {0x10, 0x30};

    CHECK(error_of(missing) == error_code::malformed);
}

TEST_CASE("a capability with unsorted, duplicate or no members is malformed") {
    raw_manifest unsorted = valid();
    unsorted.capabilities.front().members = {0x20, 0x10};
    raw_manifest duplicate = valid();
    duplicate.capabilities.front().members = {0x10, 0x10};
    raw_manifest empty = valid();
    empty.capabilities.front().members = {};

    CHECK(error_of(unsorted) == error_code::malformed);
    CHECK(error_of(duplicate) == error_code::malformed);
    CHECK(error_of(empty) == error_code::malformed);
}

TEST_CASE("unsorted or duplicate capabilities are malformed") {
    raw_manifest unsorted = valid();
    unsorted.capabilities = {
        raw_capability{.key = 0xc2, .level = 0, .members = {0x10}},
        raw_capability{.key = 0xc1, .level = 0, .members = {0x20}},
    };
    raw_manifest duplicate = valid();
    duplicate.capabilities = {
        raw_capability{.key = 0xc1, .level = 0, .members = {0x10}},
        raw_capability{.key = 0xc1, .level = 1, .members = {0x20}},
    };

    CHECK(error_of(unsorted) == error_code::malformed);
    CHECK(error_of(duplicate) == error_code::malformed);
}

TEST_CASE("a capability level this build doesn't know is malformed") {
    raw_manifest unknown = valid();
    unknown.capabilities.front().level = 2;

    CHECK(error_of(unknown) == error_code::malformed);
}

TEST_CASE("a key of 0 names no fact and no capability, and is malformed") {
    raw_manifest zero_fact = valid();
    zero_fact.facts.front().key = 0;
    zero_fact.capabilities.front().members = {0, 0x20};
    raw_manifest zero_capability = valid();
    zero_capability.capabilities.front().key = 0;

    CHECK(error_of(zero_fact) == error_code::malformed);
    CHECK(error_of(zero_capability) == error_code::malformed);
}

TEST_CASE("trailing bytes after a canonical manifest are malformed") {
    std::vector<std::byte> bytes = bytes_of(valid());
    bytes.push_back(std::byte{0});

    const result<release_manifest> decoded = decode_release_manifest(bytes);

    REQUIRE_FALSE(decoded.has_value());
    CHECK(decoded.error().code == error_code::malformed);
}

TEST_CASE("a manifest cut short anywhere is malformed") {
    const std::vector<std::byte> bytes = bytes_of(valid());

    for (usize length = 0; length < bytes.size(); ++length) {
        const result<release_manifest> decoded =
            decode_release_manifest(std::span{bytes}.first(length));
        REQUIRE_FALSE(decoded.has_value());
        CHECK(decoded.error().code == error_code::malformed);
    }
}

TEST_CASE("a wrong magic is malformed, an unknown version a version mismatch") {
    raw_manifest wrong_magic = valid();
    wrong_magic.magic = 0x3153'464c;
    raw_manifest next_version = valid();
    next_version.version = 2;

    CHECK(error_of(wrong_magic) == error_code::malformed);
    CHECK(error_of(next_version) == error_code::version_mismatch);
}

}
}
