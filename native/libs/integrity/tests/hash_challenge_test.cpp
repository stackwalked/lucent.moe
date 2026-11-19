#include <lucent/integrity/hash_challenge.hpp>

#include <algorithm>
#include <cstddef>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/crypto/crypto.hpp>
#include <lucent/integrity/expected_bytes.hpp>
#include <lucent/os/address_range.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/relocations.hpp>

#include "fixture.hpp"

namespace lucent::integrity {
namespace {

auto nonce_from(u8 seed) -> nonce {
    nonce key{};
    for (std::byte& part : key) {
        part = static_cast<std::byte>(seed);
        seed = static_cast<u8>((seed * 31U) + 7U);
    }
    return key;
}

auto in_memory(const loaded_fixture& loaded, pe::rva_range range) -> os::address_range {
    return os::address_range{
        .begin = loaded.base + range.rva,
        .end = loaded.base + range.rva + range.size,
    };
}

auto expected_answer(const loaded_fixture& loaded, const nonce& key, pe::rva_range range)
    -> crypto::digest {
    const result<std::vector<std::byte>> bytes =
        expected_bytes(file_view(loaded), loaded.base, range);
    REQUIRE(bytes.has_value());
    return answer(key, *bytes);
}

auto has_relocation_in(const pe::image_view& file, pe::rva_range range) -> bool {
    const result<std::vector<u32>> slots = pe::relocations_of(file);
    REQUIRE(slots.has_value());
    return std::ranges::any_of(*slots, [range](u32 slot) {
        return slot >= range.rva && slot + sizeof(u64) <= range.rva + range.size;
    });
}

TEST_CASE("the answer over loaded code matches the one reproduced from its file at that base") {
    const loaded_fixture loaded = load_fixture();
    const pe::rva_range code = code_section(file_view(loaded));
    const nonce key = nonce_from(3);

    CHECK(answer(key, in_memory(loaded, code)) == expected_answer(loaded, key, code));
    unload(loaded);
}

TEST_CASE("a range across relocated pointers matches only once the file is relocated to the base") {
    const loaded_fixture loaded = load_fixture();
    const pe::image_view file = file_view(loaded);
    const u32 table = export_rva(loaded, "fixture_operations");
    // Starts mid-way into the bytes before the table and ends past it, so the range's edges fall
    // where no slot does.
    const pe::rva_range across{.rva = table - 5, .size = (3 * sizeof(u64)) + 11};
    REQUIRE(has_relocation_in(file, across));
    const nonce key = nonce_from(11);
    const crypto::digest loaded_answer = answer(key, in_memory(loaded, across));

    CHECK(loaded_answer == expected_answer(loaded, key, across));
    const result<std::vector<std::byte>> unrelocated =
        expected_bytes(file, file.image_base(), across);
    REQUIRE(unrelocated.has_value());
    CHECK(loaded_answer != answer(key, *unrelocated));
    unload(loaded);
}

TEST_CASE("the same bytes under another nonce give another answer") {
    const std::vector<std::byte> bytes(64, std::byte{0x90});

    CHECK(answer(nonce_from(1), bytes) != answer(nonce_from(2), bytes));
}

TEST_CASE("a range past the end of the image is malformed") {
    const loaded_fixture loaded = load_fixture();
    const pe::image_view file = file_view(loaded);
    const pe::rva_range past{.rva = file.size_of_image() - 4, .size = 8};

    const result<std::vector<std::byte>> bytes = expected_bytes(file, loaded.base, past);
    REQUIRE_FALSE(bytes.has_value());
    CHECK(bytes.error().code == error_code::malformed);
    unload(loaded);
}

}
}
