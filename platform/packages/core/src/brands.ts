import type { z } from "zod";
import { invariant } from "./contain.ts";
import type { CryptoRng } from "./rng.ts";

// The branded scalars without zod, for the browser: a page holds and checks ids without loading
// zod (about 26 KB of its first load). The types are the ones scalars.ts's schemas produce (zod's
// brand is type-only), and scalars.ts builds those schemas from the patterns here, so a guard and
// its schema accept the same values; web/tests/brands.test.ts holds them to that.

type Branded<T, B extends string> = T & z.$brand<B>;

export type EpochMs = Branded<number, "EpochMs">;
export type Seconds = Branded<number, "Seconds">;
export type ServiceEpoch = Branded<number, "ServiceEpoch">;
export type AccountId = Branded<string, "AccountId">;
export type RoleId = Branded<string, "RoleId">;
export type EntitlementId = Branded<string, "EntitlementId">;
export type OperationId = Branded<string, "OperationId">;
export type ProductId = Branded<string, "ProductId">;
export type ChannelId = Branded<string, "ChannelId">;
export type BearerToken = Branded<string, "BearerToken">;
export type SessionId = Branded<string, "SessionId">;
export type FeatureTag = Branded<string, "FeatureTag">;

export const ACCOUNT_ID_PATTERN = /^acc_[A-Za-z0-9_-]{22}$/;
export const ROLE_ID_PATTERN = /^role_[A-Za-z0-9_-]{2,48}$/;
export const ENTITLEMENT_ID_PATTERN = /^ent_[A-Za-z0-9_-]{22}$/;
export const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const PRODUCT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
// 256 random bits, base64url: what a browser holds for a session, flow or setup link.
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{22}$/;
export const FEATURE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// zod's .int() is a safe integer, and its number refuses NaN and the infinities.
export const isEpochMs = (value: unknown): value is EpochMs =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isSeconds = (value: unknown): value is Seconds =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isServiceEpoch = (value: unknown): value is ServiceEpoch =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const matches = (pattern: RegExp, value: unknown): value is string =>
    typeof value === "string" && pattern.test(value);

export const isAccountId = (value: unknown): value is AccountId =>
    matches(ACCOUNT_ID_PATTERN, value);
export const isRoleId = (value: unknown): value is RoleId => matches(ROLE_ID_PATTERN, value);
export const isEntitlementId = (value: unknown): value is EntitlementId =>
    matches(ENTITLEMENT_ID_PATTERN, value);
export const isOperationId = (value: unknown): value is OperationId =>
    matches(OPERATION_ID_PATTERN, value);
export const isProductId = (value: unknown): value is ProductId =>
    matches(PRODUCT_ID_PATTERN, value);
export const isChannelId = (value: unknown): value is ChannelId =>
    matches(CHANNEL_ID_PATTERN, value);
export const isBearerToken = (value: unknown): value is BearerToken =>
    matches(BEARER_TOKEN_PATTERN, value);
export const isSessionId = (value: unknown): value is SessionId =>
    matches(SESSION_ID_PATTERN, value);
export const isFeatureTag = (value: unknown): value is FeatureTag =>
    matches(FEATURE_TAG_PATTERN, value);

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX_ALPHABET = "0123456789abcdef";

export function toBase64Url(bytes: Uint8Array): string {
    let out = "";
    let i = 0;
    while (i + 3 <= bytes.byteLength) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1] ?? 0;
        const b2 = bytes[i + 2] ?? 0;
        const chunk = (b0 << 16) | (b1 << 8) | b2;
        out += BASE64URL_ALPHABET[(chunk >>> 18) & 63];
        out += BASE64URL_ALPHABET[(chunk >>> 12) & 63];
        out += BASE64URL_ALPHABET[(chunk >>> 6) & 63];
        out += BASE64URL_ALPHABET[chunk & 63];
        i += 3;
    }
    const remaining = bytes.byteLength - i;
    if (remaining === 1) {
        const b0 = bytes[i] ?? 0;
        out += BASE64URL_ALPHABET[(b0 >>> 2) & 63];
        out += BASE64URL_ALPHABET[(b0 & 3) << 4];
    } else if (remaining === 2) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1] ?? 0;
        const chunk = (b0 << 8) | b1;
        out += BASE64URL_ALPHABET[(chunk >>> 10) & 63];
        out += BASE64URL_ALPHABET[(chunk >>> 4) & 63];
        out += BASE64URL_ALPHABET[(chunk & 15) << 2];
    }
    return out;
}

export function toHex(bytes: Uint8Array): string {
    let out = "";
    for (const byte of bytes) {
        out += HEX_ALPHABET[(byte >>> 4) & 0x0f];
        out += HEX_ALPHABET[byte & 0x0f];
    }
    return out;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
    const raw = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const digest = await crypto.subtle.digest("SHA-256", copy);
    return toHex(new Uint8Array(digest));
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
    const raw = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const digest = await crypto.subtle.digest("SHA-256", copy);
    return toBase64Url(new Uint8Array(digest));
}

function randomPrefixed<T>(prefix: string, rng: CryptoRng, is: (value: unknown) => value is T): T {
    const id = `${prefix}_${toBase64Url(rng.fillBytes(new Uint8Array(16)))}`;
    invariant(is(id), `random ${prefix} id fits its pattern`);
    return id;
}

export const newAccountId = (rng: CryptoRng): AccountId => randomPrefixed("acc", rng, isAccountId);
export const newEntitlementId = (rng: CryptoRng): EntitlementId =>
    randomPrefixed("ent", rng, isEntitlementId);
export const newSessionId = (rng: CryptoRng): SessionId => randomPrefixed("ses", rng, isSessionId);
export const newOperationId = (rng: CryptoRng): OperationId =>
    randomPrefixed("op", rng, isOperationId);
