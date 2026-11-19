#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <iterator>
#include <string_view>

#include <lucent/core/narrow.hpp>

namespace lucent {

// The key identifier_hash takes: one of lucent::build's 256-bit per-purpose subkeys.
using identifier_key = std::array<std::byte, 32>;

namespace detail::blake2b {

// RFC 7693 section 2.6 (SHA-512's IV) and section 2.7 (the message schedule; rounds 10 and 11
// reuse rows 0 and 1).
inline constexpr std::array<u64, 8> initial_chain{
    0x6a09'e667'f3bc'c908,
    0xbb67'ae85'84ca'a73b,
    0x3c6e'f372'fe94'f82b,
    0xa54f'f53a'5f1d'36f1,
    0x510e'527f'ade6'82d1,
    0x9b05'688c'2b3e'6c1f,
    0x1f83'd9ab'fb41'bd6b,
    0x5be0'cd19'137e'2179,
};

using schedule = std::array<u8, 16>;

inline constexpr std::array<schedule, 10> sigma{
    schedule{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    schedule{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    schedule{11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    schedule{7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    schedule{9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    schedule{2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    schedule{12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    schedule{13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    schedule{6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    schedule{10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
};

inline constexpr isize block_size = 128;
inline constexpr isize rounds = 12;
inline constexpr u64 digest_size = 8;
// The finalization flag word of the last block (section 3.2's f0); 0 for every other block.
inline constexpr u64 last_block = ~u64{0};

// Sixteen words: a message block, or the compression's working vector.
using words = std::array<u64, 16>;
using chain = std::array<u64, 8>;

// The four word positions one mixing step works on.
struct lane {
    usize a = 0;
    usize b = 0;
    usize c = 0;
    usize d = 0;
};

inline constexpr std::array<lane, 8> lanes{
    lane{.a = 0, .b = 4, .c = 8, .d = 12},
    lane{.a = 1, .b = 5, .c = 9, .d = 13},
    lane{.a = 2, .b = 6, .c = 10, .d = 14},
    lane{.a = 3, .b = 7, .c = 11, .d = 15},
    lane{.a = 0, .b = 5, .c = 10, .d = 15},
    lane{.a = 1, .b = 6, .c = 11, .d = 12},
    lane{.a = 2, .b = 7, .c = 8, .d = 13},
    lane{.a = 3, .b = 4, .c = 9, .d = 14},
};

// The two message words one mixing step takes, as section 3.1 names them.
struct message_words {
    u64 x = 0;
    u64 y = 0;
};

// RFC 7693 section 3.1, the function G.
constexpr auto mix(words work, lane place, message_words input) -> words {
    work.at(place.a) = work.at(place.a) + work.at(place.b) + input.x;
    work.at(place.d) = std::rotr(work.at(place.d) ^ work.at(place.a), 32);
    work.at(place.c) = work.at(place.c) + work.at(place.d);
    work.at(place.b) = std::rotr(work.at(place.b) ^ work.at(place.c), 24);
    work.at(place.a) = work.at(place.a) + work.at(place.b) + input.y;
    work.at(place.d) = std::rotr(work.at(place.d) ^ work.at(place.a), 16);
    work.at(place.c) = work.at(place.c) + work.at(place.d);
    work.at(place.b) = std::rotr(work.at(place.b) ^ work.at(place.c), 63);
    return work;
}

// What one block adds to the chain: its counter (bytes hashed so far, this block included) and
// its finalization flag word.
struct block_position {
    u64 counter = 0;
    u64 flag = 0;
};

// RFC 7693 section 3.2, the function F. Inputs here are far below 2^64 bytes, so the counter's
// high word is always 0.
constexpr auto compress(chain state, const words& message, block_position position) -> chain {
    words work{};
    for (usize i = 0; i < state.size(); ++i) {
        work.at(i) = state.at(i);
        work.at(i + 8) = initial_chain.at(i);
    }
    work[12] ^= position.counter;
    work[14] ^= position.flag;
    for (isize round = 0; round < rounds; ++round) {
        const schedule& order = sigma.at(narrow<usize>(round % 10));
        for (usize step = 0; step < lanes.size(); ++step) {
            const message_words input{
                .x = message.at(order.at(2 * step)),
                .y = message.at(order.at((2 * step) + 1)),
            };
            work = mix(work, lanes.at(step), input);
        }
    }
    for (usize i = 0; i < state.size(); ++i) {
        state.at(i) ^= work.at(i) ^ work.at(i + 8);
    }
    return state;
}

// The keyed input as RFC 7693 section 3.3 lays it out: the key zero-padded to a full block, then
// the name.
constexpr auto byte_at(const identifier_key& key, std::string_view name, isize position) -> u64 {
    if (position < std::ssize(key)) {
        return std::to_integer<u64>(key.at(narrow<usize>(position)));
    }
    if (position < block_size) {
        return 0;
    }
    const isize offset = position - block_size;
    return offset < std::ssize(name) ? static_cast<u8>(name.at(narrow<usize>(offset))) : 0;
}

// Little-endian words, as section 2.4 reads a block.
constexpr auto block_at(const identifier_key& key, std::string_view name, isize start) -> words {
    words block{};
    for (usize word = 0; word < block.size(); ++word) {
        for (isize part = 0; part < 8; ++part) {
            const isize position = start + (narrow<isize>(word) * 8) + part;
            block.at(word) |= byte_at(key, name, position) << narrow<u64>(part * 8);
        }
    }
    return block;
}

}

// A name's identifier under a key: keyed BLAKE2b (RFC 7693) with a 64-bit digest, which is
// Python's hashlib.blake2b(name, key=key, digest_size=8) read little-endian. Never 0, so 0 can
// mean "none".
//
// Why BLAKE2b: keyed BLAKE2 is a PRF under its key (section 3.3 makes the key a full first block,
// and BLAKE2 has no length extension), and it takes the whole 256-bit subkey, where SipHash, the
// usual short-input PRF, takes 128 bits. It is plain integer arithmetic, so clang-cl evaluates it
// in a consteval constructor with no dependency, and the same code runs in the tools at run time.
// It is the hash libs/crypto already ships (Monocypher), and the server's and tests' runtimes have
// it in their standard libraries. FNV-1a, which it replaced for fact keys, is invertible: a guessed
// name and its shipped hash gave back the seed. A 64-bit digest stays unpredictable without the
// key; n names collide with odds near n^2 / 2^65, which the release manifest refuses anyway.
constexpr auto identifier_hash(const identifier_key& key, std::string_view name) -> u64 {
    // Parameter block word 0 (section 2.5): digest length, key length, fanout 1, depth 1.
    constexpr u64 parameters =
        0x0101'0000U | (u64{identifier_key{}.size()} << 8U) | detail::blake2b::digest_size;
    constexpr isize block_size = detail::blake2b::block_size;
    detail::blake2b::chain state = detail::blake2b::initial_chain;
    state[0] ^= parameters;
    const isize length = block_size + std::ssize(name);
    for (isize start = 0; start < length; start += block_size) {
        const bool is_last = start + block_size >= length;
        const detail::blake2b::block_position position{
            .counter = narrow<u64>(is_last ? length : start + block_size),
            .flag = is_last ? detail::blake2b::last_block : 0,
        };
        state =
            detail::blake2b::compress(state, detail::blake2b::block_at(key, name, start), position);
    }
    return state[0] == 0 ? 1 : state[0];
}

}
