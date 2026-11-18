import type { CryptoRng } from "../core/rng.ts";
import { BearerToken, toBase64Url } from "../core/scalars.ts";

// Only a token's SHA-256 is stored, so a database read never yields a usable token.
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
