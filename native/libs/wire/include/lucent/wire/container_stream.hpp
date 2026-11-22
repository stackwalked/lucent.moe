#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>

// The container as a start downloads it (contracts/container-stream/v1): the packed container cut
// into 64 KiB chunks, each sealed with XChaCha20-Poly1305 under the start's container key with its
// own random nonce. Each chunk's index and whether it is the last are in its associated data, so a
// cut, reordered or spliced stream fails, and the loader verifies each chunk as it arrives.

namespace lucent::wire {

inline constexpr usize container_chunk_size = usize{64} << 10U;
inline constexpr usize sealed_chunk_overhead = crypto::aead_nonce_size + crypto::aead_tag_size;

enum class chunk_position : u8 {
    inner = 0,
    last = 1,
};

auto chunk_associated_data(u32 index, chunk_position position) -> std::vector<std::byte>;

// At least one: an empty container is one empty last chunk.
auto chunk_count(usize packed_size) -> usize;

// One nonce per chunk, never repeated under the key.
auto seal_container_stream(
    const crypto::secret_key& key,
    std::span<const std::byte> packed,
    std::span<const crypto::aead_nonce> nonces
) -> std::vector<std::byte>;

// Opens a stream as it arrives. A chunk is opened once the bytes after it show it isn't the last;
// whatever remains at finish() is the last chunk.
class container_stream_opener final {
public:
    // The key is borrowed for the opener's lifetime.
    explicit container_stream_opener(const crypto::secret_key& key);

    container_stream_opener(const container_stream_opener&) = delete ("holds plaintext");
    auto operator=(const container_stream_opener&)
        -> container_stream_opener& = delete ("holds plaintext");
    container_stream_opener(container_stream_opener&&) = delete ("borrows its key in place");
    auto operator=(container_stream_opener&&)
        -> container_stream_opener& = delete ("borrows its key in place");
    // Wipes whatever plaintext it still holds.
    ~container_stream_opener();

    // Fails as malformed at the first chunk that doesn't open; the opener is spent then.
    auto feed(std::span<const std::byte> bytes) -> result<void>;

    // The packed container, in plaintext: the caller wipes it once done (crypto::wipe). Fails as
    // malformed when the last chunk doesn't open as the last.
    auto finish() -> result<std::vector<std::byte>>;

private:
    auto open_chunk(std::span<const std::byte> sealed, chunk_position position) -> result<void>;

    const crypto::secret_key* m_key;
    std::vector<std::byte> m_pending;
    std::vector<std::byte> m_plain;
    u32 m_index = 0;
    bool m_is_spent = false;
};

auto open_container_stream(const crypto::secret_key& key, std::span<const std::byte> stream)
    -> result<std::vector<std::byte>>;

}
