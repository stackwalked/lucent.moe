#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/crypto/crypto.hpp>

#include "hex.hpp"

// Known answers from RFC 7748 (X25519) and draft-irtf-cfrg-xchacha-03 (XChaCha20-Poly1305). They
// catch the silent failure: a channel that works end to end between two Monocyphers and that no
// other implementation, the server's included, can speak.

namespace lucent::crypto {
namespace {

TEST_CASE("X25519 gives RFC 7748's public keys and shared secret for its two parties") {
    const exchange_key alice = exchange_key::from_seed(
        test::bytes_of<32>("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    );
    const exchange_key bob = exchange_key::from_seed(
        test::bytes_of<32>("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
    );
    const exchange_public_key shared =
        test::bytes_of<32>("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");

    const result<secret_key> alice_side = alice.shared_secret(bob.public_part());
    const result<secret_key> bob_side = bob.shared_secret(alice.public_part());

    CHECK(
        alice.public_part()
        == test::bytes_of<32>("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
    );
    CHECK(
        bob.public_part()
        == test::bytes_of<32>("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
    );
    REQUIRE(alice_side.has_value());
    REQUIRE(bob_side.has_value());
    CHECK(std::ranges::equal(alice_side->as_bytes(), shared));
    CHECK(std::ranges::equal(bob_side->as_bytes(), shared));
}

TEST_CASE("a key exchange with a low-order peer key is refused") {
    const exchange_key ours = exchange_key::from_seed(
        test::bytes_of<32>("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    );
    // u = 0 and u = 1 are of order 4 and 1; every scalar maps them to an all-zero secret.
    const exchange_public_key zero{};
    const exchange_public_key one =
        test::bytes_of<32>("0100000000000000000000000000000000000000000000000000000000000000");

    CHECK_FALSE(ours.shared_secret(zero).has_value());
    CHECK_FALSE(ours.shared_secret(one).has_value());
}

constexpr std::string_view xchacha_plain =
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, "
    "sunscreen would be it.";

auto xchacha_key() -> secret_key {
    return secret_key::from_bytes(
        test::bytes_of<32>("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
    );
}

constexpr aead_nonce xchacha_nonce =
    test::bytes_of<24>("404142434445464748494a4b4c4d4e4f5051525354555657");
constexpr std::array xchacha_associated = test::bytes_of<12>("50515253c0c1c2c3c4c5c6c7");

auto xchacha_sealed() -> std::vector<std::byte> {
    return test::vector_of(
        "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4e"
        "da7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b"
        "2383565d3fff921f9664c97637da9768812f615c68b13b52e"
        "c0875924c1c7987947deafd8780acf49"
    );
}

TEST_CASE("sealing gives the XChaCha20-Poly1305 draft's ciphertext and tag") {
    const std::vector<std::byte> sealed = seal(
        xchacha_key(), xchacha_nonce, xchacha_associated, std::as_bytes(std::span{xchacha_plain})
    );

    CHECK(sealed == xchacha_sealed());
}

TEST_CASE("opening the XChaCha20-Poly1305 draft's ciphertext gives its plaintext") {
    const result<secret_bytes> opened =
        open(xchacha_key(), xchacha_nonce, xchacha_associated, xchacha_sealed());

    REQUIRE(opened.has_value());
    CHECK(std::ranges::equal(opened->as_bytes(), std::as_bytes(std::span{xchacha_plain})));
}

TEST_CASE("a sealed text opens under nothing but its key, nonce and associated data unchanged") {
    std::vector<std::byte> flipped_text = xchacha_sealed();
    flipped_text.front() ^= std::byte{0x01};
    std::array associated = xchacha_associated;
    associated.back() ^= std::byte{0x01};
    aead_nonce nonce = xchacha_nonce;
    nonce.back() ^= std::byte{0x01};
    const secret_key other_key = secret_key::from_bytes(
        test::bytes_of<32>("818182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
    );

    CHECK_FALSE(open(xchacha_key(), xchacha_nonce, xchacha_associated, flipped_text).has_value());
    CHECK_FALSE(open(xchacha_key(), xchacha_nonce, associated, xchacha_sealed()).has_value());
    CHECK_FALSE(open(xchacha_key(), nonce, xchacha_associated, xchacha_sealed()).has_value());
    CHECK_FALSE(open(other_key, xchacha_nonce, xchacha_associated, xchacha_sealed()).has_value());
    CHECK_FALSE(open(xchacha_key(), xchacha_nonce, xchacha_associated, {}).has_value());
}

}
}
