#include "cng/device_key.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <utility>

#include <Windows.h>

#include <ncrypt.h>

#include <lucent/core/narrow.hpp>
#include <lucent/wire/enrollment.hpp>

#include "cng/sha256.hpp"

namespace lucent::loader {
namespace {

// The persisted key's name in its provider, per Windows user. Changing it orphans every PC's key,
// which then enrolls again as a new device.
constexpr const wchar_t* key_name = L"lucent device key";

// build: ncrypt.h, NTE_BAD_KEYSET (0x80090016): NCryptOpenKey's answer for a name the provider
//        doesn't hold
// found: the Windows SDK and NCryptOpenKey's documentation
// breaks: every start would try to create a key that exists, which fails, and nothing signs
constexpr SECURITY_STATUS no_such_key = NTE_BAD_KEYSET;

auto failure_of(SECURITY_STATUS status) -> error {
    return error{.code = error_code::system, .system_code = std::bit_cast<u32>(status)};
}

// An NCRYPT_HANDLE, freed with NCryptFreeObject.
class ncrypt_object final {
public:
    explicit ncrypt_object(NCRYPT_HANDLE handle)
        : m_handle{handle} {}

    ncrypt_object(const ncrypt_object&) = delete ("one owner per handle");
    auto operator=(const ncrypt_object&) -> ncrypt_object& = delete ("one owner per handle");

    ncrypt_object(ncrypt_object&& other) noexcept
        : m_handle{std::exchange(other.m_handle, 0)} {}

    auto operator=(ncrypt_object&&) -> ncrypt_object& = delete ("one owner per handle");

    ~ncrypt_object() {
        if (m_handle != 0) {
            NCryptFreeObject(m_handle);
        }
    }

    auto native() const -> NCRYPT_HANDLE {
        return m_handle;
    }

    auto release() -> NCRYPT_HANDLE {
        return std::exchange(m_handle, 0);
    }

private:
    NCRYPT_HANDLE m_handle;
};

auto open_provider(const wchar_t* name) -> result<ncrypt_object> {
    NCRYPT_PROV_HANDLE provider = 0;
    const SECURITY_STATUS status = NCryptOpenStorageProvider(&provider, name, 0);
    if (status != ERROR_SUCCESS) {
        return std::unexpected(failure_of(status));
    }
    return ncrypt_object{provider};
}

// The persisted key in this provider; nothing when it holds none by that name.
auto open_key(const ncrypt_object& provider) -> result<std::optional<ncrypt_object>> {
    NCRYPT_KEY_HANDLE key = 0;
    const SECURITY_STATUS status = NCryptOpenKey(provider.native(), &key, key_name, 0, 0);
    if (status == no_such_key) {
        return std::nullopt;
    }
    if (status != ERROR_SUCCESS) {
        return std::unexpected(failure_of(status));
    }
    return ncrypt_object{key};
}

enum class persistence : u8 { persisted, ephemeral };

// A new P-256 key. Software keys refuse export: the default export policy is already none, set
// again so a changed default can't make one exportable. The TPM never exports.
auto create_key(const ncrypt_object& provider, wire::key_storage storage, persistence kept)
    -> result<ncrypt_object> {
    NCRYPT_KEY_HANDLE handle = 0;
    const wchar_t* const name = kept == persistence::persisted ? key_name : nullptr;
    const SECURITY_STATUS created = NCryptCreatePersistedKey(
        provider.native(), &handle, BCRYPT_ECDSA_P256_ALGORITHM, name, 0, 0
    );
    if (created != ERROR_SUCCESS) {
        return std::unexpected(failure_of(created));
    }
    ncrypt_object key{handle};
    if (storage == wire::key_storage::software) {
        DWORD policy = 0;
        const SECURITY_STATUS set = NCryptSetProperty(
            key.native(),
            NCRYPT_EXPORT_POLICY_PROPERTY,
            // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): CNG takes its buffers as PBYTE.
            reinterpret_cast<PBYTE>(&policy),
            sizeof(policy),
            NCRYPT_PERSIST_FLAG
        );
        if (set != ERROR_SUCCESS) {
            return std::unexpected(failure_of(set));
        }
    }
    const SECURITY_STATUS finalized = NCryptFinalizeKey(key.native(), 0);
    if (finalized != ERROR_SUCCESS) {
        return std::unexpected(failure_of(finalized));
    }
    return key;
}

// build: bcrypt.h, BCRYPT_ECCKEY_BLOB: a u32 magic and a u32 cbKey, then X and Y of cbKey bytes
//        each, big-endian; BCRYPT_ECDSA_PUBLIC_P256_MAGIC (0x31534345, "ECS1") for a P-256 public
//        key
// found: the Windows SDK and BCRYPT_ECCKEY_BLOB's documentation
// breaks: the JWK carries another point than the key signs with, and every proof is refused
auto public_point_of(const ncrypt_object& key) -> result<p256_point> {
    constexpr usize header_size = sizeof(BCRYPT_ECCKEY_BLOB);
    std::array<std::byte, header_size + (2 * p256_coordinate_size)> blob{};
    DWORD written = 0;
    const SECURITY_STATUS status = NCryptExportKey(
        key.native(),
        0,
        BCRYPT_ECCPUBLIC_BLOB,
        nullptr,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): CNG takes its buffers as PBYTE.
        reinterpret_cast<PBYTE>(blob.data()),
        narrow<DWORD>(blob.size()),
        &written,
        0
    );
    if (status != ERROR_SUCCESS) {
        return std::unexpected(failure_of(status));
    }
    std::array<std::byte, header_size> header_bytes{};
    std::ranges::copy(std::span{blob}.first(header_size), header_bytes.begin());
    const auto header = std::bit_cast<BCRYPT_ECCKEY_BLOB>(header_bytes);
    if (written != blob.size()
        || header.dwMagic != BCRYPT_ECDSA_PUBLIC_P256_MAGIC
        || header.cbKey != p256_coordinate_size) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    p256_point point;
    const std::span<const std::byte> coordinates = std::span{blob}.subspan(header_size);
    std::ranges::copy(coordinates.first(p256_coordinate_size), point.x.begin());
    std::ranges::copy(coordinates.subspan(p256_coordinate_size), point.y.begin());
    return point;
}

struct found_key {
    ncrypt_object key;
    wire::key_storage storage;
};

auto find_or_make() -> result<found_key> {
    const result<ncrypt_object> tpm = open_provider(MS_PLATFORM_CRYPTO_PROVIDER);
    const ncrypt_object software = LUCENT_TRY(open_provider(MS_KEY_STORAGE_PROVIDER));
    if (tpm) {
        std::optional<ncrypt_object> held = LUCENT_TRY(open_key(*tpm));
        if (held) {
            return found_key{.key = *std::move(held), .storage = wire::key_storage::tpm};
        }
    }
    std::optional<ncrypt_object> held = LUCENT_TRY(open_key(software));
    if (held) {
        return found_key{.key = *std::move(held), .storage = wire::key_storage::software};
    }
    if (tpm) {
        result<ncrypt_object> made =
            create_key(*tpm, wire::key_storage::tpm, persistence::persisted);
        // A TPM that won't make the key (locked out, no free handle) leaves the software key.
        if (made) {
            return found_key{.key = *std::move(made), .storage = wire::key_storage::tpm};
        }
    }
    return found_key{
        .key =
            LUCENT_TRY(create_key(software, wire::key_storage::software, persistence::persisted)),
        .storage = wire::key_storage::software,
    };
}

}

auto device_key::open_or_create() -> result<device_key> {
    found_key found = LUCENT_TRY(find_or_make());
    const p256_point point = LUCENT_TRY(public_point_of(found.key));
    return device_key{found.key.release(), found.storage, point};
}

auto device_key::ephemeral() -> result<device_key> {
    const ncrypt_object software = LUCENT_TRY(open_provider(MS_KEY_STORAGE_PROVIDER));
    ncrypt_object key =
        LUCENT_TRY(create_key(software, wire::key_storage::software, persistence::ephemeral));
    const p256_point point = LUCENT_TRY(public_point_of(key));
    return device_key{key.release(), wire::key_storage::software, point};
}

device_key::device_key(uptr handle, wire::key_storage storage, p256_point point)
    : m_handle{handle}
    , m_storage{storage}
    , m_point{point} {}

device_key::device_key(device_key&& other) noexcept
    : m_handle{std::exchange(other.m_handle, 0)}
    , m_storage{other.m_storage}
    , m_point{other.m_point} {}

device_key::~device_key() {
    if (m_handle != 0) {
        NCryptFreeObject(m_handle);
    }
}

auto device_key::storage() const -> wire::key_storage {
    return m_storage;
}

auto device_key::public_point() const -> const p256_point& {
    return m_point;
}

auto device_key::sign(std::span<const std::byte> message) const -> result<es256_signature> {
    sha256_digest digest = sha256(message);
    es256_signature signature{};
    DWORD written = 0;
    // An ECDSA key signs into IEEE P1363's r || s, which is JOSE's layout already.
    const SECURITY_STATUS status = NCryptSignHash(
        m_handle,
        nullptr,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): CNG takes its buffers as PBYTE.
        reinterpret_cast<PBYTE>(digest.data()),
        narrow<DWORD>(digest.size()),
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): CNG takes its buffers as PBYTE.
        reinterpret_cast<PBYTE>(signature.data()),
        narrow<DWORD>(signature.size()),
        &written,
        0
    );
    if (status != ERROR_SUCCESS) {
        return std::unexpected(failure_of(status));
    }
    if (written != signature.size()) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    return signature;
}

}
