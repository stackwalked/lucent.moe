import { invariant } from "@lucent/core/contain";
import type { EpochMs } from "@lucent/core/scalars";

// An authenticator app, written from RFC 6238 rather than taken from platform, so a test that
// signs in with it checks platform against the standard instead of against itself: HMAC-SHA1,
// 6 digits, 30-second steps, the secret in RFC 4648 base32.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

function fromBase32(text: string): Uint8Array {
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of text.replaceAll(/[\s=]/g, "").toUpperCase()) {
        const value = ALPHABET.indexOf(char);
        invariant(value >= 0, `not base32: ${char}`);
        buffer = (buffer << 5) | value;
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(bytes);
}

export async function totpCodeAt(secret: string, at: EpochMs): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.from(fromBase32(secret)),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"],
    );
    const counter = new Uint8Array(8);
    new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(at / STEP_MS)));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const offset = (mac[19] ?? 0) & 0x0f;
    const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
    return String(binary % 1_000_000).padStart(6, "0");
}
