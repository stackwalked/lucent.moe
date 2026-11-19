#include <lucent/wire/container.hpp>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/container_stream.hpp>
#include <lucent/wire/release_seal.hpp>

#include "container_fixtures.hpp"
#include "fixtures.hpp"

// The refusals change encoded bytes at offsets written out here, so they state the layout
// independently of the encoder, which refuses to write anything that isn't canonical. The small
// container's body: header 0..84, three 13-byte section entries from 84, three relocations from
// 123, two 20-byte imports from 135, section data from 175.

namespace lucent::wire {
namespace {

constexpr usize image_size_at = 16;
constexpr usize entry_at = 20;
constexpr usize boot_at = 24;
constexpr usize sections_at = 84;
constexpr usize section_entry_size = 13;
constexpr usize relocations_at = 123;
constexpr usize data_at = 175;

auto small_body() -> std::vector<std::byte> {
    return encode_container_body(fixtures::small_container());
}

auto put_u32(std::vector<std::byte>& bytes, usize offset, u32 value) -> void {
    for (usize index = 0; index < 4; ++index) {
        bytes.at(offset + index) = static_cast<std::byte>((value >> (8U * index)) & 0xffU);
    }
}

auto error_of(std::span<const std::byte> body) -> std::optional<error_code> {
    const result<container> decoded = decode_container_body(body);
    return decoded ? std::nullopt : std::optional{decoded.error().code};
}

TEST_CASE("a container body decodes to what was encoded, and no prefix or extension of it does") {
    const std::vector<std::byte> body = small_body();

    CHECK(decode_container_body(body) == fixtures::small_container());
    for (const usize size : {usize{0}, usize{83}, usize{174}, body.size() - 1}) {
        CHECK(error_of(std::span{body}.first(size)) == error_code::malformed);
    }
    std::vector<std::byte> extended = body;
    extended.push_back(std::byte{0});
    CHECK(error_of(extended) == error_code::malformed);
}

TEST_CASE("a section of unknown access, writable and executable among them, is malformed") {
    std::vector<std::byte> body = small_body();
    // 4 would be read, write and execute; there is no such access.
    body.at(sections_at + 12) = std::byte{4};

    CHECK(error_of(body) == error_code::malformed);
}

TEST_CASE("sections that overlap, or run past the image, are malformed") {
    std::vector<std::byte> overlapping = small_body();
    put_u32(overlapping, sections_at + section_entry_size, 0x1000);
    std::vector<std::byte> past_the_end = small_body();
    put_u32(past_the_end, image_size_at, 0x5000);

    CHECK(error_of(overlapping) == error_code::malformed);
    CHECK(error_of(past_the_end) == error_code::malformed);
}

TEST_CASE("a section whose stored bytes end in a zero page is malformed") {
    std::vector<std::byte> body = small_body();
    // The read-only section's only stored page.
    const usize page_at = data_at + container_page_size;
    std::fill_n(body.begin() + static_cast<isize>(page_at), container_page_size, std::byte{0});

    CHECK(error_of(body) == error_code::malformed);
}

TEST_CASE("a relocation outside every section, or overlapping the one before, is malformed") {
    std::vector<std::byte> outside = small_body();
    put_u32(outside, relocations_at, 0x0);
    std::vector<std::byte> overlapping = small_body();
    put_u32(overlapping, relocations_at + 4, 0x2104);

    CHECK(error_of(outside) == error_code::malformed);
    CHECK(error_of(overlapping) == error_code::malformed);
}

TEST_CASE("an entry point or boot entry outside the code is malformed") {
    std::vector<std::byte> entry = small_body();
    put_u32(entry, entry_at, 0x2000);
    std::vector<std::byte> boot = small_body();
    put_u32(boot, boot_at, 0x4000);

    CHECK(error_of(entry) == error_code::malformed);
    CHECK(error_of(boot) == error_code::malformed);
}

TEST_CASE("a packed container unpacks only with its exact sizes, nothing trailing, at version 1") {
    const std::vector<std::byte> packed = pack_container(fixtures::small_container());
    std::vector<std::byte> trailing = packed;
    trailing.push_back(std::byte{0});
    std::vector<std::byte> long_body = packed;
    put_u32(long_body, 32, narrow<u32>(small_body().size() + 1));
    std::vector<std::byte> later = packed;
    later.at(18) = std::byte{'2'};

    CHECK(unpack_container(packed) == fixtures::small_container());
    CHECK(unpack_container(trailing).error().code == error_code::malformed);
    CHECK(unpack_container(long_body).error().code == error_code::malformed);
    CHECK(unpack_container(later).error().code == error_code::version_mismatch);
}

TEST_CASE("an import hash depends on the key and on every byte of the name") {
    const import_key other = fixtures::filled<import_key_size>(0x5b);

    CHECK(import_hash(fixtures::imports_key, "kernel32.dll") != import_hash(other, "kernel32.dll"));
    CHECK(
        import_hash(fixtures::imports_key, "kernel32.dll")
        != import_hash(fixtures::imports_key, "KERNEL32.dll")
    );
}

auto plain() -> std::vector<std::byte> {
    return fixtures::stream_plain(fixtures::stream_plain_size);
}

auto stream() -> std::vector<std::byte> {
    return seal_container_stream(fixtures::container_key(), plain(), fixtures::stream_nonces(2));
}

constexpr usize first_chunk_size = container_chunk_size + sealed_chunk_overhead;

TEST_CASE("a container stream opens the same whatever pieces it arrives in") {
    const std::vector<std::byte> sealed = stream();
    const crypto::secret_key key = fixtures::container_key();
    container_stream_opener opener{key};
    for (usize offset = 0; offset < sealed.size(); offset += 1000) {
        const usize size = std::min(usize{1000}, sealed.size() - offset);
        REQUIRE(opener.feed(std::span{sealed}.subspan(offset, size)).has_value());
    }

    CHECK(opener.finish() == plain());
    CHECK(open_container_stream(key, sealed) == plain());
}

TEST_CASE("a container stream cut after a full chunk, or with its chunks swapped, never opens") {
    const std::vector<std::byte> sealed = stream();
    const crypto::secret_key key = fixtures::container_key();
    const std::span<const std::byte> first = std::span{sealed}.first(first_chunk_size);
    const std::span<const std::byte> second = std::span{sealed}.subspan(first_chunk_size);
    std::vector<std::byte> swapped{second.begin(), second.end()};
    swapped.insert(swapped.end(), first.begin(), first.end());
    std::vector<std::byte> trailing = sealed;
    trailing.push_back(std::byte{0});

    CHECK_FALSE(open_container_stream(key, first).has_value());
    CHECK_FALSE(open_container_stream(key, swapped).has_value());
    CHECK_FALSE(open_container_stream(key, trailing).has_value());
}

TEST_CASE("a container stream opens only under its start's key") {
    const crypto::secret_key other =
        crypto::secret_key::from_bytes(fixtures::filled<crypto::secret_key_size>(0xcd));

    CHECK_FALSE(open_container_stream(other, stream()).has_value());
}

TEST_CASE("an empty last chunk after others is refused: only an empty container has one") {
    const crypto::secret_key key = fixtures::container_key();
    const std::vector<std::byte> exact = fixtures::stream_plain(container_chunk_size);
    std::vector<std::byte> sealed = seal_container_stream(key, exact, fixtures::stream_nonces(1));
    // The first chunk sealed again as inner, then an empty last chunk.
    const crypto::aead_nonce first_nonce = fixtures::stream_nonces(2).at(0);
    const crypto::aead_nonce last_nonce = fixtures::stream_nonces(2).at(1);
    std::vector<std::byte> padded{first_nonce.begin(), first_nonce.end()};
    const std::vector<std::byte> inner =
        crypto::seal(key, first_nonce, chunk_associated_data(0, chunk_position::inner), exact);
    padded.insert(padded.end(), inner.begin(), inner.end());
    padded.insert(padded.end(), last_nonce.begin(), last_nonce.end());
    const std::vector<std::byte> empty =
        crypto::seal(key, last_nonce, chunk_associated_data(1, chunk_position::last), {});
    padded.insert(padded.end(), empty.begin(), empty.end());

    CHECK(open_container_stream(key, sealed) == exact);
    CHECK_FALSE(open_container_stream(key, padded).has_value());
}

auto code_key() -> crypto::public_key {
    return crypto::signing_key::from_seed(fixtures::code_seed).public_part();
}

TEST_CASE("a release seal verifies only under the code key and only as signed") {
    const std::vector<std::byte> sealed = encode_release_seal(fixtures::module_seal());
    std::vector<std::byte> renumbered = sealed;
    // The number's low byte: after the context (32), the product (1 + 3) and the channel (1).
    renumbered.at(37) = std::byte{8};
    const crypto::public_key other =
        crypto::signing_key::from_seed(fixtures::other_seed).public_part();

    CHECK(verify_release_seal(sealed, code_key()) == fixtures::module_seal());
    CHECK_FALSE(verify_release_seal(sealed, other).has_value());
    CHECK(decode_release_seal(renumbered).has_value());
    CHECK_FALSE(verify_release_seal(renumbered, code_key()).has_value());
}

TEST_CASE("a release seal numbered 0, or with a mixed or unordered artifact set, is malformed") {
    const std::vector<std::byte> sealed = encode_release_seal(fixtures::module_seal());
    std::vector<std::byte> zero = sealed;
    zero.at(37) = std::byte{0};
    // The artifacts after the boot_info version: count at 65, kinds at 66 and 99.
    std::vector<std::byte> mixed = sealed;
    mixed.at(99) = std::byte{4};
    std::vector<std::byte> unordered = sealed;
    unordered.at(66) = std::byte{2};
    unordered.at(99) = std::byte{1};

    CHECK(decode_release_seal(zero).error().code == error_code::malformed);
    CHECK(decode_release_seal(mixed).error().code == error_code::malformed);
    CHECK(decode_release_seal(unordered).error().code == error_code::malformed);
}

}
}
