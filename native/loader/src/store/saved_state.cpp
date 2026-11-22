#include "store/saved_state.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <Windows.h>

#include <KnownFolders.h>
#include <ShlObj.h>
#include <dpapi.h>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/ids.hpp>

#include "text/text_bytes.hpp"

namespace lucent::loader {
namespace {

constexpr u8 state_version = 1;
constexpr usize max_token_size = 4096;
constexpr usize max_products = 255;
constexpr const wchar_t* state_file = L"state.bin";
// DPAPI's optional entropy: a blob sealed for another purpose under this user doesn't open here.
constexpr std::string_view seal_purpose = "lucent loader state v1";

auto malformed() -> std::unexpected<error> {
    return std::unexpected(error{.code = error_code::malformed});
}

auto little_endian(u64 value) -> std::array<std::byte, sizeof(u64)> {
    std::array<std::byte, sizeof(u64)> bytes{};
    u32 shift = 0;
    for (std::byte& part : bytes) {
        part = std::byte{static_cast<u8>(value >> shift)};
        shift += 8;
    }
    return bytes;
}

// Reads the bytes front to back; every read past the end fails.
class cursor final {
public:
    explicit cursor(std::span<const std::byte> bytes)
        : m_rest{bytes} {}

    auto take(usize count) -> result<std::span<const std::byte>> {
        if (m_rest.size() < count) {
            return malformed();
        }
        const std::span<const std::byte> taken = m_rest.first(count);
        m_rest = m_rest.subspan(count);
        return taken;
    }

    auto byte() -> result<u8> {
        return std::to_integer<u8>(LUCENT_TRY(take(1)).front());
    }

    auto little(usize width) -> result<u64> {
        u64 value = 0;
        u32 shift = 0;
        for (const std::byte part : LUCENT_TRY(take(width))) {
            value |= std::to_integer<u64>(part) << shift;
            shift += 8;
        }
        return value;
    }

    auto is_done() const -> bool {
        return m_rest.empty();
    }

private:
    std::span<const std::byte> m_rest;
};

// A DATA_BLOB DPAPI allocated, freed with LocalFree.
class local_blob final {
public:
    local_blob() = default;
    local_blob(const local_blob&) = delete ("LocalFree once");
    auto operator=(const local_blob&) -> local_blob& = delete ("LocalFree once");
    local_blob(local_blob&&) = delete ("filled in place");
    auto operator=(local_blob&&) -> local_blob& = delete ("filled in place");

    ~local_blob() {
        if (blob.pbData != nullptr) {
            LocalFree(blob.pbData);
        }
    }

    auto bytes() const -> std::span<const std::byte> {
        // DPAPI allocated exactly cbData bytes at pbData.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container"
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): BYTE and std::byte share one object representation.
        return std::span{reinterpret_cast<const std::byte*>(blob.pbData), blob.cbData};
#pragma clang diagnostic pop
    }

    DATA_BLOB blob{};
};

auto blob_of(std::span<const std::byte> bytes) -> DATA_BLOB {
    return DATA_BLOB{
        .cbData = narrow<DWORD>(bytes.size()),
        // DPAPI takes BYTE* for its input but only reads it.
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast,cppcoreguidelines-pro-type-reinterpret-cast): see above
        .pbData = const_cast<BYTE*>(reinterpret_cast<const BYTE*>(bytes.data())),
    };
}

auto sealed(std::span<const std::byte> plain) -> result<std::vector<std::byte>> {
    DATA_BLOB input = blob_of(plain);
    DATA_BLOB entropy = blob_of(as_bytes(seal_purpose));
    local_blob output;
    if (CryptProtectData(
            &input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output.blob
        )
        == FALSE) {
        return std::unexpected(last_system_error());
    }
    const std::span<const std::byte> bytes = output.bytes();
    return std::vector<std::byte>{bytes.begin(), bytes.end()};
}

auto opened(std::span<const std::byte> sealed_bytes) -> result<std::vector<std::byte>> {
    DATA_BLOB input = blob_of(sealed_bytes);
    DATA_BLOB entropy = blob_of(as_bytes(seal_purpose));
    local_blob output;
    if (CryptUnprotectData(
            &input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output.blob
        )
        == FALSE) {
        return std::unexpected(last_system_error());
    }
    const std::span<const std::byte> bytes = output.bytes();
    return std::vector<std::byte>{bytes.begin(), bytes.end()};
}

// The module seals' part: a count, then each product's id and its three numbers.
auto read_module_seals(cursor& read, saved_state& state) -> result<void> {
    const u8 products = LUCENT_TRY(read.byte());
    for (u8 index = 0; index < products; ++index) {
        const u8 size = LUCENT_TRY(read.byte());
        if (size == 0 || size > wire::max_product_size) {
            return malformed();
        }
        std::string product{as_text(LUCENT_TRY(read.take(size)))};
        std::array<u64, channel_count> numbers{};
        for (u64& number : numbers) {
            number = LUCENT_TRY(read.little(sizeof(u64)));
        }
        if (!state.highest_module_seal.emplace(std::move(product), numbers).second) {
            return malformed();
        }
    }
    return {};
}

}

auto highest_seal_of(const saved_state& state, wire::channel chosen) -> u64 {
    return state.highest_loader_seal.at(std::to_underlying(chosen));
}

auto raise_highest_seal(saved_state& state, wire::channel chosen, u64 number) -> void {
    u64& highest = state.highest_loader_seal.at(std::to_underlying(chosen));
    highest = std::max(highest, number);
}

auto highest_module_seal_of(
    const saved_state& state, std::string_view product, wire::channel chosen
) -> u64 {
    const auto found = state.highest_module_seal.find(std::string{product});
    if (found == state.highest_module_seal.end()) {
        return 0;
    }
    return found->second.at(std::to_underlying(chosen));
}

auto raise_module_seal(
    saved_state& state, std::string_view product, wire::channel chosen, u64 number
) -> void {
    u64& highest = state.highest_module_seal[std::string{product}].at(std::to_underlying(chosen));
    highest = std::max(highest, number);
}

auto encode_saved_state(const saved_state& state) -> std::vector<std::byte> {
    LUCENT_INVARIANT(state.refresh_token.size() <= max_token_size);
    std::vector<std::byte> bytes{std::byte{state_version}};
    const auto token_size = narrow<u16>(state.refresh_token.size());
    bytes.push_back(std::byte{static_cast<u8>(token_size)});
    bytes.push_back(std::byte{static_cast<u8>(token_size >> 8U)});
    const std::span<const std::byte> token = as_bytes(state.refresh_token);
    bytes.insert(bytes.end(), token.begin(), token.end());
    bytes.push_back(std::byte{state.is_enrolled ? u8{1} : u8{0}});
    bytes.push_back(std::byte{std::to_underlying(state.chosen)});
    for (const u64 number : state.highest_loader_seal) {
        const std::array<std::byte, sizeof(u64)> encoded = little_endian(number);
        bytes.insert(bytes.end(), encoded.begin(), encoded.end());
    }
    LUCENT_INVARIANT(state.highest_module_seal.size() <= max_products);
    bytes.push_back(std::byte{narrow<u8>(state.highest_module_seal.size())});
    for (const auto [product, numbers] : state.highest_module_seal) {
        LUCENT_INVARIANT(product.size() <= wire::max_product_size);
        bytes.push_back(std::byte{narrow<u8>(product.size())});
        const std::span<const std::byte> name = as_bytes(product);
        bytes.insert(bytes.end(), name.begin(), name.end());
        for (const u64 number : numbers) {
            const std::array<std::byte, sizeof(u64)> encoded = little_endian(number);
            bytes.insert(bytes.end(), encoded.begin(), encoded.end());
        }
    }
    return bytes;
}

auto decode_saved_state(std::span<const std::byte> bytes) -> result<saved_state> {
    cursor read{bytes};
    if (LUCENT_TRY(read.byte()) != state_version) {
        return std::unexpected(error{.code = error_code::version_mismatch});
    }
    saved_state state;
    const u64 token_size = LUCENT_TRY(read.little(2));
    if (token_size > max_token_size) {
        return malformed();
    }
    state.refresh_token = std::string{as_text(LUCENT_TRY(read.take(narrow<usize>(token_size))))};
    const u8 enrolled = LUCENT_TRY(read.byte());
    if (enrolled > 1) {
        return malformed();
    }
    state.is_enrolled = enrolled == 1;
    const u8 chosen = LUCENT_TRY(read.byte());
    if (chosen >= channel_count) {
        return malformed();
    }
    state.chosen = static_cast<wire::channel>(chosen);
    for (u64& number : state.highest_loader_seal) {
        number = LUCENT_TRY(read.little(sizeof(u64)));
    }
    LUCENT_TRY(read_module_seals(read, state));
    if (!read.is_done()) {
        return malformed();
    }
    return state;
}

auto install_root() -> result<std::filesystem::path> {
    PWSTR found = nullptr;
    const HRESULT status = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &found);
    if (FAILED(status)) {
        CoTaskMemFree(found);
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(status)}
        );
    }
    std::filesystem::path root = std::filesystem::path{found} / L"lucent";
    CoTaskMemFree(found);
    return root;
}

auto load_saved_state(const std::filesystem::path& root) -> saved_state {
    const result<std::vector<std::byte>> file = os::read_file(root / state_file);
    if (!file) {
        return saved_state{};
    }
    const result<std::vector<std::byte>> plain = opened(*file);
    if (!plain) {
        return saved_state{};
    }
    result<saved_state> state = decode_saved_state(*plain);
    return state ? *std::move(state) : saved_state{};
}

auto save_state(const std::filesystem::path& root, const saved_state& state) -> result<void> {
    std::error_code failure;
    std::filesystem::create_directories(root, failure);
    const std::vector<std::byte> bytes = LUCENT_TRY(sealed(encode_saved_state(state)));
    const std::filesystem::path written = root / L"state.bin.new";
    LUCENT_TRY(os::write_file(written, bytes));
    if (MoveFileExW(
            written.c_str(),
            (root / state_file).c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
        )
        == FALSE) {
        return std::unexpected(last_system_error());
    }
    return {};
}

}
