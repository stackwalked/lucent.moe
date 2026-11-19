// The primitives native/libs/crypto signs and hashes with (Monocypher 4): BLAKE2b with a 32-byte
// output, and standard Ed25519 (RFC 8032, SHA-512). Both checked against the golden vectors in
// contracts/: real BLAKE2b-256, not BLAKE2b-512 cut short, which gives other bytes.

export const DIGEST_SIZE = 32;
export const PUBLIC_KEY_SIZE = 32;
export const SIGNATURE_SIZE = 64;

export function blake2b256(message: Uint8Array): Uint8Array<ArrayBuffer> {
    // Bun 1.4.4's digest(into) wants 64 bytes of room even for a 32-byte digest, so copy out.
    return new Uint8Array(new Bun.CryptoHasher("blake2b256").update(message).digest());
}

// Whether `signature` is `publicKey`'s over exactly `message`.
export async function isSignedBy(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
): Promise<boolean> {
    const key = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(publicKey),
        { name: "Ed25519" },
        false,
        ["verify"],
    );
    return crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        new Uint8Array(signature),
        new Uint8Array(message),
    );
}
