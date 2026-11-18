import { z } from "zod";
import type { CryptoRng } from "./rng.ts";

export const EpochMs = z.number().int().nonnegative().brand<"EpochMs">();
export type EpochMs = z.infer<typeof EpochMs>;

export const Seconds = z.number().int().nonnegative().brand<"Seconds">();
export type Seconds = z.infer<typeof Seconds>;

export const ServiceEpoch = z.number().int().positive().brand<"ServiceEpoch">();
export type ServiceEpoch = z.infer<typeof ServiceEpoch>;

export const AccountId = z
    .string()
    .regex(/^acc_[A-Za-z0-9_-]{22}$/)
    .brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

export const RoleId = z
    .string()
    .regex(/^role_[A-Za-z0-9_-]{2,48}$/)
    .brand<"RoleId">();
export type RoleId = z.infer<typeof RoleId>;

export const EntitlementId = z
    .string()
    .regex(/^ent_[A-Za-z0-9_-]{22}$/)
    .brand<"EntitlementId">();
export type EntitlementId = z.infer<typeof EntitlementId>;

export const OperationId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .brand<"OperationId">();
export type OperationId = z.infer<typeof OperationId>;

export const ProductId = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,31}$/)
    .brand<"ProductId">();
export type ProductId = z.infer<typeof ProductId>;

export const ChannelId = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,15}$/)
    .brand<"ChannelId">();
export type ChannelId = z.infer<typeof ChannelId>;

export const FeatureTag = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .brand<"FeatureTag">();
export type FeatureTag = z.infer<typeof FeatureTag>;

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

function randomPrefixed(prefix: string, rng: CryptoRng): string {
    const bytes = rng.fillBytes(new Uint8Array(16));
    return `${prefix}_${toBase64Url(bytes)}`;
}

export const newAccountId = (rng: CryptoRng): AccountId =>
    AccountId.parse(randomPrefixed("acc", rng));
export const newEntitlementId = (rng: CryptoRng): EntitlementId =>
    EntitlementId.parse(randomPrefixed("ent", rng));
export const newOperationId = (rng: CryptoRng): OperationId =>
    OperationId.parse(randomPrefixed("op", rng));
