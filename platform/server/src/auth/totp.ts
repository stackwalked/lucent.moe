import { invariant, tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import type { AccountId, EpochMs } from "@lucent/core/scalars";

// RFC 6238 with the parameters every authenticator app defaults to: HMAC-SHA1, 6 digits, 30 s.
const STEP_MS = 30_000;
const DIGITS = 6;
const SECRET_BYTES = 20;
// One step either side: a code typed as it rolls over, or a phone clock a little off.
const WINDOW_STEPS = 1;
const IV_BYTES = 12;

export type TotpKey = {
    readonly kid: string;
    readonly key: CryptoKey;
};

// Seals new secrets under `current`; opens anything sealed under a key still listed, so a key
// can be rotated by adding the new one first and dropping the old one once nothing uses it.
export type TotpKeyring = {
    readonly current: TotpKey;
    readonly byKid: ReadonlyMap<string, TotpKey>;
};

export async function createTotpKeyring(
    keys: readonly { readonly kid: string; readonly raw: Uint8Array }[],
): Promise<TotpKeyring> {
    const imported: TotpKey[] = [];
    for (const { kid, raw } of keys) {
        invariant(raw.byteLength === 32, `TOTP key ${kid} must be 32 bytes`);
        const key = await crypto.subtle.importKey("raw", Uint8Array.from(raw), "AES-GCM", false, [
            "encrypt",
            "decrypt",
        ]);
        imported.push({ kid, key });
    }
    const current = imported[0];
    invariant(current !== undefined, "the TOTP keyring needs at least one key");
    return { current, byKid: new Map(imported.map((entry) => [entry.kid, entry])) };
}

// The account id is authenticated data: a sealed secret copied onto another account won't open.
function additionalData(accountId: AccountId, kid: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`lucent.totp\0${accountId}\0${kid}`);
}

export type SealedSecret = {
    readonly kid: string;
    readonly sealed: Uint8Array;
};

export async function sealTotpSecret(params: {
    readonly keyring: TotpKeyring;
    readonly rng: CryptoRng;
    readonly accountId: AccountId;
    readonly secret: Uint8Array;
}): Promise<SealedSecret> {
    const { kid, key } = params.keyring.current;
    const iv = new Uint8Array(IV_BYTES);
    params.rng.fillBytes(iv);
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(params.accountId, kid) },
        key,
        Uint8Array.from(params.secret),
    );
    const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    sealed.set(iv, 0);
    sealed.set(new Uint8Array(ciphertext), IV_BYTES);
    return { kid, sealed };
}

export type TotpUnsealFailure = { readonly code: "TOTP_UNREADABLE" };

export async function openTotpSecret(params: {
    readonly keyring: TotpKeyring;
    readonly accountId: AccountId;
    readonly sealed: SealedSecret;
}): Promise<Result<Uint8Array, TotpUnsealFailure>> {
    const entry = params.keyring.byKid.get(params.sealed.kid);
    if (entry === undefined || params.sealed.sealed.byteLength <= IV_BYTES) {
        return err({ code: "TOTP_UNREADABLE" });
    }
    const iv = params.sealed.sealed.slice(0, IV_BYTES);
    const body = params.sealed.sealed.slice(IV_BYTES);
    const opened = await tryAsync(
        () =>
            crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv,
                    additionalData: additionalData(params.accountId, entry.kid),
                },
                entry.key,
                body,
            ),
        (): TotpUnsealFailure => ({ code: "TOTP_UNREADABLE" }),
    );
    if (!opened.ok) return opened;
    return ok(new Uint8Array(opened.value));
}

export function newTotpSecret(rng: CryptoRng): Uint8Array {
    return rng.fillBytes(new Uint8Array(SECRET_BYTES));
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function toBase32(bytes: Uint8Array): string {
    let out = "";
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
}

export function totpUri(params: {
    readonly issuer: string;
    readonly username: string;
    readonly secret: Uint8Array;
}): string {
    const label = encodeURIComponent(`${params.issuer}:${params.username}`);
    const query = new URLSearchParams({
        secret: toBase32(params.secret),
        issuer: params.issuer,
        algorithm: "SHA1",
        digits: String(DIGITS),
        period: String(STEP_MS / 1_000),
    });
    return `otpauth://totp/${label}?${query.toString()}`;
}

export function totpStepAt(at: EpochMs): number {
    return Math.floor(at / STEP_MS);
}

export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(secret),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"],
    );
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(step));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const offset = (mac[mac.byteLength - 1] ?? 0) & 0x0f;
    const view = new DataView(mac.buffer, offset, 4);
    const binary = view.getUint32(0) & 0x7fff_ffff;
    return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

// The step the code belongs to, if it's within the window and later than any accepted before;
// the caller stores it as the new `last_used_step`, which is what refuses a replay.
export async function matchTotpCode(params: {
    readonly secret: Uint8Array;
    readonly code: string;
    readonly at: EpochMs;
    readonly lastUsedStep: number;
}): Promise<number | null> {
    if (!/^\d{6}$/.test(params.code)) return null;
    const now = totpStepAt(params.at);
    let matched: number | null = null;
    // Every candidate is computed, so timing doesn't say which step matched.
    for (let step = now - WINDOW_STEPS; step <= now + WINDOW_STEPS; step++) {
        const candidate = await totpCode(params.secret, step);
        if (candidate === params.code && step > params.lastUsedStep && matched === null) {
            matched = step;
        }
    }
    return matched;
}
