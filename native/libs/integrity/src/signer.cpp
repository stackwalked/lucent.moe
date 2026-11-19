#include "signer.hpp"

#include <array>
#include <optional>
#include <string>
#include <vector>

#include <Windows.h>

#include <SoftPub.h>
#include <WinTrust.h>
#include <bcrypt.h>
#include <mscat.h>
#include <wincrypt.h>

namespace lucent::integrity::detail {
namespace {

// Offline and silent: a probe never waits on the network or shows a dialog.
constexpr DWORD offline = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;

auto has_microsoft_root(const CERT_CHAIN_CONTEXT* chain, DWORD root_flags) -> bool {
    CERT_CHAIN_POLICY_PARA policy{};
    policy.cbSize = sizeof(policy);
    policy.dwFlags = root_flags;
    CERT_CHAIN_POLICY_STATUS status{};
    status.cbSize = sizeof(status);
    return CertVerifyCertificateChainPolicy(
               CERT_CHAIN_POLICY_MICROSOFT_ROOT, chain, &policy, &status
           ) != 0
           && status.dwError == 0;
}

auto signer_of_chain(HANDLE state) -> signer {
    CRYPT_PROVIDER_DATA* const provider = WTHelperProvDataFromStateData(state);
    if (provider == nullptr) {
        return signer::other;
    }
    const CRYPT_PROVIDER_SGNR* const signature =
        WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0);
    if (signature == nullptr || signature->pChainContext == nullptr) {
        return signer::other;
    }
    // Without flags the policy accepts Microsoft's product roots, which Windows chains to; the
    // application root flag accepts only the 2011 application root, which Microsoft's software
    // outside Windows chains to. Seen on 10.0.26100: ntdll's chain ends at Microsoft Root
    // Certificate Authority 2010 and fails the policy with the flag set.
    const bool is_microsoft =
        has_microsoft_root(signature->pChainContext, 0)
        || has_microsoft_root(
            signature->pChainContext, MICROSOFT_ROOT_CERT_CHAIN_POLICY_CHECK_APPLICATION_ROOT_FLAG
        );
    return is_microsoft ? signer::microsoft : signer::other;
}

// Runs the verification `data` describes, and classifies its signer while the state is open.
auto verified_signer(WINTRUST_DATA& data) -> std::optional<signer> {
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    std::optional<signer> found;
    if (WinVerifyTrust(nullptr, &action, &data) == ERROR_SUCCESS) {
        found = signer_of_chain(data.hWVTStateData);
    }
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &action, &data);
    return found;
}

auto trust_data() -> WINTRUST_DATA {
    WINTRUST_DATA data{};
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwProvFlags = offline;
    return data;
}

auto embedded_signer(void* file, const std::wstring& path) -> std::optional<signer> {
    WINTRUST_FILE_INFO subject{};
    subject.cbStruct = sizeof(subject);
    subject.pcwszFilePath = path.c_str();
    subject.hFile = file;
    WINTRUST_DATA data = trust_data();
    data.dwUnionChoice = WTD_CHOICE_FILE;
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access): Win32's union; dwUnionChoice names the member.
    data.pFile = &subject;
    return verified_signer(data);
}

auto hex_digit(u32 nibble) -> wchar_t {
    return static_cast<wchar_t>(nibble < 10 ? L'0' + nibble : L'A' + (nibble - 10));
}

// A catalog names its members by the uppercase hex of their hash.
auto member_tag(const std::vector<BYTE>& hash) -> std::wstring {
    std::wstring tag;
    tag.reserve(hash.size() * 2);
    for (const BYTE value : hash) {
        tag.push_back(hex_digit(u32{value} >> 4U));
        tag.push_back(hex_digit(u32{value} & 0xfU));
    }
    return tag;
}

struct catalog_subject {
    HCATADMIN admin = nullptr;
    void* file = nullptr;
    const std::wstring* path = nullptr;
};

auto file_hash(const catalog_subject& subject) -> std::optional<std::vector<BYTE>> {
    // Hashing reads from the file's current position.
    const LARGE_INTEGER start{};
    if (SetFilePointerEx(subject.file, start, nullptr, FILE_BEGIN) == 0) {
        return std::nullopt;
    }
    DWORD size = 0;
    CryptCATAdminCalcHashFromFileHandle2(subject.admin, subject.file, &size, nullptr, 0);
    if (size == 0) {
        return std::nullopt;
    }
    std::vector<BYTE> hash(size);
    if (CryptCATAdminCalcHashFromFileHandle2(subject.admin, subject.file, &size, hash.data(), 0)
        == 0) {
        return std::nullopt;
    }
    return hash;
}

auto signer_in_catalog(const catalog_subject& subject, HCATINFO catalog, std::vector<BYTE>& hash)
    -> std::optional<signer> {
    CATALOG_INFO found{};
    found.cbStruct = sizeof(found);
    if (CryptCATCatalogInfoFromContext(catalog, &found, 0) == 0) {
        return std::nullopt;
    }
    const std::wstring tag = member_tag(hash);
    WINTRUST_CATALOG_INFO member{};
    member.cbStruct = sizeof(member);
    member.pcwszCatalogFilePath = std::data(found.wszCatalogFile);
    member.pcwszMemberTag = tag.c_str();
    member.pcwszMemberFilePath = subject.path->c_str();
    member.hMemberFile = subject.file;
    member.pbCalculatedFileHash = hash.data();
    member.cbCalculatedFileHash = static_cast<DWORD>(hash.size());
    member.hCatAdmin = subject.admin;
    WINTRUST_DATA data = trust_data();
    data.dwUnionChoice = WTD_CHOICE_CATALOG;
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access): as in embedded_signer.
    data.pCatalog = &member;
    return verified_signer(data);
}

auto catalog_signer_with(const catalog_subject& subject) -> std::optional<signer> {
    std::optional<std::vector<BYTE>> hash = file_hash(subject);
    if (!hash) {
        return std::nullopt;
    }
    HCATINFO catalog = CryptCATAdminEnumCatalogFromHash(
        subject.admin, hash->data(), static_cast<DWORD>(hash->size()), 0, nullptr
    );
    if (catalog == nullptr) {
        return std::nullopt;
    }
    const std::optional<signer> found = signer_in_catalog(subject, catalog, *hash);
    CryptCATAdminReleaseCatalogContext(subject.admin, catalog, 0);
    return found;
}

// Catalogs list SHA-256 hashes on current Windows and SHA-1 on older files; nullptr asks for
// SHA-1.
auto catalog_signer(void* file, const std::wstring& path, const wchar_t* algorithm)
    -> std::optional<signer> {
    HCATADMIN admin = nullptr;
    if (CryptCATAdminAcquireContext2(&admin, nullptr, algorithm, nullptr, 0) == 0) {
        return std::nullopt;
    }
    const std::optional<signer> found =
        catalog_signer_with(catalog_subject{.admin = admin, .file = file, .path = &path});
    CryptCATAdminReleaseContext(admin, 0);
    return found;
}

}

auto signer_of(void* file, const std::wstring& path) -> signer {
    if (const std::optional<signer> embedded = embedded_signer(file, path)) {
        return *embedded;
    }
    if (const std::optional<signer> listed = catalog_signer(file, path, BCRYPT_SHA256_ALGORITHM)) {
        return *listed;
    }
    return catalog_signer(file, path, nullptr).value_or(signer::none);
}

}
