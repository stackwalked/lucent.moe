import { invariant } from "@lucent/core/contain";

// What a suspended account's tombstone keeps of its address: HMAC-SHA256 of the normalized address
// under a key derived from each TOTP key (HKDF-SHA256, info naming this use and the key's kid).
// Keyed, so the column is not a lookup table anyone holding a list of addresses can join against;
// only this server, holding the secret, can ask "is this address one of them". A derived key, not
// a TOTP key itself, so neither use can stand in for the other. Recognising an address computes it
// under every listed key, so a TOTP key rotation keeps old tombstones recognisable while the old
// key stays listed; dropping a key forgets the tombstones hashed under it.
export type EmailDigest = { readonly kid: string; readonly digest: Uint8Array };

export type EmailHasher = {
    // Under the newest key, for a tombstone being written.
    readonly current: (email: string) => Promise<EmailDigest>;
    // Under every listed key, for recognising an address.
    readonly candidates: (email: string) => Promise<readonly Uint8Array[]>;
};

const INFO = "lucent.email-hash.v1\0";

function normalize(email: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(email.trim().toLowerCase());
}

export async function createEmailHasher(
    keys: readonly { readonly kid: string; readonly raw: Uint8Array }[],
): Promise<EmailHasher> {
    const derived: { readonly kid: string; readonly key: CryptoKey }[] = [];
    for (const { kid, raw } of keys) {
        const base = await crypto.subtle.importKey("raw", Uint8Array.from(raw), "HKDF", false, [
            "deriveKey",
        ]);
        const key = await crypto.subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(0),
                info: new TextEncoder().encode(`${INFO}${kid}`),
            },
            base,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            ["sign"],
        );
        derived.push({ kid, key });
    }
    const newest = derived[0];
    invariant(newest !== undefined, "the email hasher needs at least one key");
    const sign = async (key: CryptoKey, email: string) =>
        new Uint8Array(await crypto.subtle.sign("HMAC", key, normalize(email)));
    return {
        current: async (email) => ({ kid: newest.kid, digest: await sign(newest.key, email) }),
        candidates: async (email) => {
            const out: Uint8Array[] = [];
            for (const { key } of derived) out.push(await sign(key, email));
            return out;
        },
    };
}
