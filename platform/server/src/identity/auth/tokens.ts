import type { CryptoRng } from "@lucent/core/rng";
import { BearerToken, toBase64Url } from "@lucent/core/scalars";

// Authentication tables store only the SHA-256. A reset mail's bearer exists in the outbox
// only while the provider still needs its envelope.
export type IssuedToken = {
    readonly token: BearerToken;
    readonly hash: Uint8Array;
};

export async function hashToken(token: BearerToken): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return new Uint8Array(digest);
}

export async function issueToken(rng: CryptoRng): Promise<IssuedToken> {
    const token = BearerToken.parse(toBase64Url(rng.fillBytes(new Uint8Array(32))));
    return { token, hash: await hashToken(token) };
}
