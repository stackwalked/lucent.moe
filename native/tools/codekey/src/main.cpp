#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/container.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/release_seal.hpp>

#include "cli/options.hpp"
#include "key/key_file.hpp"
#include "key/passphrase.hpp"

namespace lucent::codekey {
namespace {

// The failure a person reads, then exit 1.
auto fail(std::string message) -> std::unexpected<std::string> {
    return std::unexpected(std::move(message));
}

using outcome = std::expected<void, std::string>;

// Unpadded base64url (RFC 4648, section 5): how the server's config takes a key.
auto base64url(std::span<const std::byte> bytes) -> std::string {
    constexpr std::string_view alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    u32 buffer = 0;
    u32 bits = 0;
    for (const std::byte value : bytes) {
        buffer = (buffer << 8U) | static_cast<u32>(value);
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out.push_back(alphabet.at((buffer >> bits) & 0x3fU));
        }
    }
    if (bits > 0) {
        out.push_back(alphabet.at((buffer << (6 - bits)) & 0x3fU));
    }
    return out;
}

auto hex(std::span<const std::byte> bytes) -> std::string {
    std::string out;
    for (const std::byte value : bytes) {
        out += std::format("{:02x}", static_cast<u8>(value));
    }
    return out;
}

auto read(const std::filesystem::path& path) -> std::expected<std::vector<std::byte>, std::string> {
    result<std::vector<std::byte>> bytes = os::read_file(path);
    if (!bytes) {
        return fail(std::format("can't read {}", path.string()));
    }
    return std::move(*bytes);
}

auto run(const create_command& chosen) -> outcome {
    std::error_code ignored;
    if (std::filesystem::exists(chosen.key_file, ignored)) {
        return fail(
            std::format("{} exists; a key file is never replaced", chosen.key_file.string())
        );
    }
    const result<crypto::secret_bytes> first = read_passphrase("new passphrase");
    const result<crypto::secret_bytes> second = read_passphrase("the same passphrase again");
    if (!first || !second) {
        return fail("can't read the passphrase");
    }
    if (!std::ranges::equal(first->as_bytes(), second->as_bytes())) {
        return fail("the passphrases differ");
    }
    if (first->as_bytes().size() < minimum_passphrase_size) {
        return fail(std::format("a passphrase has {} bytes at least", minimum_passphrase_size));
    }
    const result<new_key_file> made = create_key_file(first->as_bytes(), key_purpose::code);
    if (!made) {
        return fail("can't create the key (the system RNG failed)");
    }
    if (!os::write_file(chosen.key_file, made->bytes)) {
        return fail(std::format("can't write {}", chosen.key_file.string()));
    }
    std::println("code public key: {}", hex(made->public_key));
    std::println("LUCENT_CODE_PUBLIC_KEY={}", base64url(made->public_key));
    return {};
}

auto run(const public_command& chosen) -> outcome {
    const std::vector<std::byte> file = LUCENT_TRY(read(chosen.key_file));
    const result<crypto::public_key> key = public_key_of(file);
    if (!key) {
        return fail(std::format("{} isn't an offline key file", chosen.key_file.string()));
    }
    std::println("LUCENT_CODE_PUBLIC_KEY={}", base64url(*key));
    return {};
}

// Decrypts the key only now, signs, and checks the result verifies before writing it.
// Where the key is read from and the seal written to.
struct seal_paths {
    std::filesystem::path key_file;
    std::filesystem::path seal;
};

auto sign_and_write(const seal_paths& paths, wire::release_seal seal) -> outcome {
    const std::filesystem::path& out = paths.seal;
    const std::vector<std::byte> file = LUCENT_TRY(read(paths.key_file));
    const result<crypto::secret_bytes> passphrase = read_passphrase("passphrase");
    if (!passphrase) {
        return fail("can't read the passphrase");
    }
    const result<crypto::signing_key> signer = open_key_file(
        {.file = file, .passphrase = passphrase->as_bytes(), .purpose = key_purpose::code}
    );
    if (!signer) {
        return fail(
            signer.error().code == error_code::unsupported
                ? "the key file isn't a code key, or its cost is below the floor"
                : "wrong passphrase, or the key file was changed"
        );
    }
    const std::vector<std::byte> encoded =
        wire::encode_release_seal(wire::sign_release_seal(std::move(seal), *signer));
    const result<wire::release_seal> verified =
        wire::verify_release_seal(encoded, signer->public_part());
    if (!verified) {
        return fail("the seal doesn't verify under the key that signed it");
    }
    if (!os::write_file(out, encoded)) {
        return fail(std::format("can't write {}", out.string()));
    }
    std::println(
        "sealed {} release {} as number {} under {}: {}",
        verified->product,
        hex(verified->release.bytes),
        verified->number,
        hex(signer->public_part()),
        out.string()
    );
    return {};
}

auto run(const sign_module_command& chosen) -> outcome {
    const std::vector<std::byte> packed = LUCENT_TRY(read(chosen.container));
    const std::vector<std::byte> manifest_bytes = LUCENT_TRY(read(chosen.manifest));
    const result<wire::container> image = wire::unpack_container(packed);
    if (!image) {
        return fail(std::format("{} isn't a container", chosen.container.string()));
    }
    const result<bundle::release_manifest_v2> manifest =
        bundle::decode_release_manifest_v2(manifest_bytes);
    if (!manifest) {
        return fail(std::format("{} isn't a release manifest v2", chosen.manifest.string()));
    }
    if (manifest->product != chosen.product) {
        return fail(
            std::format("the manifest is {}'s, not {}'s", manifest->product, chosen.product)
        );
    }
    if (chosen.number == 0) {
        return fail("release numbers start at 1");
    }
    return sign_and_write(
        seal_paths{.key_file = chosen.key_file, .seal = chosen.seal},
        wire::release_seal{
            .product = chosen.product,
            .chosen = chosen.chosen,
            .number = chosen.number,
            .release = image->release,
            .boot_info_version = image->boot_info_version,
            .artifacts =
                {
                    wire::release_artifact{
                        .kind = wire::artifact_kind::container,
                        .digest = crypto::hash(packed),
                    },
                    wire::release_artifact{
                        .kind = wire::artifact_kind::release_manifest,
                        .digest = crypto::hash(manifest_bytes),
                    },
                },
            .signature = {},
        }
    );
}

auto run(const sign_loader_command& chosen) -> outcome {
    const std::vector<std::byte> loader = LUCENT_TRY(read(chosen.loader));
    const std::vector<std::byte> host = LUCENT_TRY(read(chosen.host));
    if (chosen.number == 0) {
        return fail("release numbers start at 1");
    }
    return sign_and_write(
        seal_paths{.key_file = chosen.key_file, .seal = chosen.seal},
        wire::release_seal{
            .product = "lucent-loader",
            .chosen = chosen.chosen,
            .number = chosen.number,
            .release = chosen.release,
            .boot_info_version = chosen.boot_info_version,
            .artifacts =
                {
                    wire::release_artifact{
                        .kind = wire::artifact_kind::loader,
                        .digest = crypto::hash(loader),
                    },
                    wire::release_artifact{
                        .kind = wire::artifact_kind::host,
                        .digest = crypto::hash(host),
                    },
                },
            .signature = {},
        }
    );
}

}
}

// The CRT's entry signature. argv is the CRT's array of argc pointers: the one place a span is
// built from a pointer and a count, and everything after reads it through that span.
// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT calls wmain by this name and signature, as it does main.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> arguments{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    const lucent::result<lucent::codekey::command> chosen =
        lucent::codekey::parse_command(arguments);
    if (!chosen) {
        return 2;
    }
    const lucent::codekey::outcome ran =
        lucent::match(*chosen, [](const auto& command) { return lucent::codekey::run(command); });
    if (!ran) {
        std::println(stderr, "codekey: {}", ran.error());
        return 1;
    }
    return 0;
}
