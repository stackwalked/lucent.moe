import { invariant } from "@lucent/core/contain";

// The online lease key (Ed25519): it signs leases and the session key exchange, each under its
// own context string, so a signature over one is never accepted as the other. Its public half
// ships inside every signed release, so rotating it costs a release.
export type LeaseSigner = {
    readonly publicKey: Uint8Array<ArrayBuffer>;
    readonly sign: (message: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
};

// RFC 8410's PKCS #8 wrapping of a raw 32-byte Ed25519 seed, which WebCrypto imports.
const PKCS8_ED25519 = Uint8Array.fromHex("302e020100300506032b657004220420");

export async function createLeaseSigner(seed: Uint8Array): Promise<LeaseSigner> {
    invariant(seed.byteLength === 32, "an Ed25519 seed is 32 bytes");
    const pkcs8 = new Uint8Array(PKCS8_ED25519.byteLength + 32);
    pkcs8.set(PKCS8_ED25519);
    pkcs8.set(seed, PKCS8_ED25519.byteLength);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", key);
    invariant(jwk.x !== undefined, "an Ed25519 JWK has its public part");
    const signing = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
        "sign",
    ]);
    pkcs8.fill(0);
    return {
        publicKey: Uint8Array.fromBase64(jwk.x, { alphabet: "base64url" }),
        sign: async (message) =>
            new Uint8Array(
                await crypto.subtle.sign({ name: "Ed25519" }, signing, new Uint8Array(message)),
            ),
    };
}
