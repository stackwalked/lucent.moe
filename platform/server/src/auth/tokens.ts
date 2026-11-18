import { z } from "zod";
import type { CryptoRng } from "../core/rng.ts";
import { toBase64Url } from "../core/scalars.ts";

// 256 random bits, base64url: what a browser holds for a session, flow or setup link. Only the
// SHA-256 is stored, so a database read never yields a usable token.
export const BearerToken = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .brand<"BearerToken">();
export type BearerToken = z.output<typeof BearerToken>;

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
