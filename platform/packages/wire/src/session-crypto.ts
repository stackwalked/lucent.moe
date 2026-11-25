import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";

// The key exchange and signing the session needs, from Bun's built-in WebCrypto: X25519 (RFC 7748)
// and Ed25519 (RFC 8032), both byte for byte with native/libs/crypto (Monocypher). Bun 1.4.4 has
// no ChaCha20 at all, so frames are sealed with @noble/ciphers instead (frame.ts).

const PKCS8_X25519 = Uint8Array.fromHex("302e020100300506032b656e04220420");
const PKCS8_ED25519 = Uint8Array.fromHex("302e020100300506032b657004220420");

export const EXCHANGE_KEY_SIZE = 32;

function withPrefix(prefix: Uint8Array, seed: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(prefix.byteLength + seed.byteLength);
    out.set(prefix);
    out.set(seed, prefix.byteLength);
    return out;
}

async function publicPartOf(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
    const exported = await crypto.subtle.exportKey("jwk", key);
    return Uint8Array.fromBase64(exported.x ?? "", { alphabet: "base64url" });
}

// The X25519 public key of a 32-byte secret, as crypto_x25519_public_key computes it.
export async function exchangePublicKey(seed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const key = await crypto.subtle.importKey(
        "pkcs8",
        withPrefix(PKCS8_X25519, seed),
        { name: "X25519" },
        true,
        ["deriveBits"],
    );
    return publicPartOf(key);
}

export type ExchangeError = { readonly code: "LOW_ORDER_KEY" };

// The shared secret with a peer's public key. A low-order peer key gives an all-zero secret
// whatever our half is, and is refused, as native/libs/crypto refuses it.
export async function sharedSecret(
    seed: Uint8Array,
    peer: Uint8Array,
): Promise<Result<Uint8Array<ArrayBuffer>, ExchangeError>> {
    const own = await crypto.subtle.importKey(
        "pkcs8",
        withPrefix(PKCS8_X25519, seed),
        { name: "X25519" },
        false,
        ["deriveBits"],
    );
    const other = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(peer),
        { name: "X25519" },
        false,
        [],
    );
    // WebCrypto itself rejects an all-zero result; the explicit check below holds whichever way a
    // runtime goes.
    const derived = await tryAsync(
        () => crypto.subtle.deriveBits({ name: "X25519", public: other }, own, 256),
        () => ({ code: "LOW_ORDER_KEY" }) as const,
    );
    if (!derived.ok) {
        return derived;
    }
    const secret = new Uint8Array(derived.value);
    if (secret.every((value) => value === 0)) {
        return err({ code: "LOW_ORDER_KEY" });
    }
    return ok(secret);
}

// The Ed25519 public key of a 32-byte seed, as crypto_ed25519_key_pair computes it.
export async function signingPublicKey(seed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const key = await crypto.subtle.importKey(
        "pkcs8",
        withPrefix(PKCS8_ED25519, seed),
        { name: "Ed25519" },
        true,
        ["sign"],
    );
    return publicPartOf(key);
}

// An Ed25519 signature from a 32-byte seed, as Monocypher's crypto_ed25519_sign makes it.
export async function signWithSeed(
    seed: Uint8Array,
    message: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
    const key = await crypto.subtle.importKey(
        "pkcs8",
        withPrefix(PKCS8_ED25519, seed),
        { name: "Ed25519" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, key, new Uint8Array(message)),
    );
}
