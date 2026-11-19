#include <lucent/wire/container_stream.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>

#include "codec.hpp"

// Version 1:
//   per chunk: nonce (24, random), ciphertext of the chunk's plaintext, tag (16). Every chunk but
//     the last holds exactly 64 KiB of plaintext; the last holds 0 to 64 KiB, and only an empty
//     container has an empty last chunk.
//   associated data: context "lucent container chunk v1" (32), u32 chunk index, u8 last (0 or 1).

namespace lucent::wire {
namespace {

constexpr u32 version = 1;
constexpr usize sealed_chunk_size = container_chunk_size + sealed_chunk_overhead;

}

auto chunk_associated_data(u32 index, chunk_position position) -> std::vector<std::byte> {
    detail::writer out;
    out.write_context("container chunk", version);
    out.write_u32(index);
    out.write_u8(std::to_underlying(position));
    return out.take();
}

auto chunk_count(usize packed_size) -> usize {
    return std::max(usize{1}, (packed_size + container_chunk_size - 1) / container_chunk_size);
}

auto seal_container_stream(
    const crypto::secret_key& key,
    std::span<const std::byte> packed,
    std::span<const crypto::aead_nonce> nonces
) -> std::vector<std::byte> {
    const usize count = chunk_count(packed.size());
    LUCENT_INVARIANT(nonces.size() == count);
    std::vector<std::byte> stream;
    stream.reserve(packed.size() + (count * sealed_chunk_overhead));
    for (const auto [position_index, nonce] : std::views::enumerate(nonces)) {
        const auto index = narrow<usize>(position_index);
        const usize offset = index * container_chunk_size;
        const std::span<const std::byte> plain =
            packed.subspan(offset, std::min(container_chunk_size, packed.size() - offset));
        const chunk_position position =
            index + 1 == count ? chunk_position::last : chunk_position::inner;
        const std::vector<std::byte> sealed =
            crypto::seal(key, nonce, chunk_associated_data(narrow<u32>(index), position), plain);
        stream.insert(stream.end(), nonce.begin(), nonce.end());
        stream.insert(stream.end(), sealed.begin(), sealed.end());
    }
    return stream;
}

container_stream_opener::container_stream_opener(const crypto::secret_key& key)
    : m_key{&key} {}

auto container_stream_opener::open_chunk(std::span<const std::byte> sealed, chunk_position position)
    -> result<void> {
    if (sealed.size() < sealed_chunk_overhead) {
        return std::unexpected(detail::malformed);
    }
    crypto::aead_nonce nonce{};
    std::ranges::copy(sealed.first(crypto::aead_nonce_size), nonce.begin());
    const crypto::secret_bytes plain = LUCENT_TRY(
        crypto::open(
            *m_key,
            nonce,
            chunk_associated_data(m_index, position),
            sealed.subspan(crypto::aead_nonce_size)
        )
    );
    // An empty last chunk stands for an empty container only.
    if (position == chunk_position::last && plain.as_bytes().empty() && m_index != 0) {
        return std::unexpected(detail::malformed);
    }
    m_plain.insert(m_plain.end(), plain.as_bytes().begin(), plain.as_bytes().end());
    ++m_index;
    return {};
}

auto container_stream_opener::feed(std::span<const std::byte> bytes) -> result<void> {
    if (m_is_spent) {
        return std::unexpected(detail::malformed);
    }
    m_pending.insert(m_pending.end(), bytes.begin(), bytes.end());
    usize consumed = 0;
    // A full chunk is inner only once a byte past it has arrived.
    while (m_pending.size() - consumed > sealed_chunk_size) {
        const result<void> opened = open_chunk(
            std::span{m_pending}.subspan(consumed, sealed_chunk_size), chunk_position::inner
        );
        if (!opened) {
            m_is_spent = true;
            return opened;
        }
        consumed += sealed_chunk_size;
    }
    m_pending.erase(m_pending.begin(), m_pending.begin() + narrow<isize>(consumed));
    return {};
}

auto container_stream_opener::finish() -> result<std::vector<std::byte>> {
    if (m_is_spent) {
        return std::unexpected(detail::malformed);
    }
    m_is_spent = true;
    LUCENT_TRY(open_chunk(m_pending, chunk_position::last));
    return std::move(m_plain);
}

auto open_container_stream(const crypto::secret_key& key, std::span<const std::byte> stream)
    -> result<std::vector<std::byte>> {
    container_stream_opener opener{key};
    LUCENT_TRY(opener.feed(stream));
    return opener.finish();
}

}
