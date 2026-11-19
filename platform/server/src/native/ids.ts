import type { CryptoRng } from "@lucent/core/rng";
import { ID_SIZE } from "@lucent/wire/codec";

// Ids the native wire carries: 16 random bytes, 32 hex digits in a path or to web.
export function newWireId(rng: CryptoRng): Uint8Array<ArrayBuffer> {
    return new Uint8Array(rng.fillBytes(new Uint8Array(ID_SIZE)));
}

// Crockford's base32: no I, L, O or U, so a code read off one screen and checked against another
// has no look-alike letters.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// What the member compares between the loader and the browser before approving: the first 40 bits
// of the device key's thumbprint as eight base32 characters, `XXXX-XXXX`. The loader computes the
// same from its own key, so a request pushed by another PC shows another code.
export function matchCodeOf(jkt: string): string {
    const digest = Uint8Array.fromBase64(jkt, { alphabet: "base64url" });
    let bits = 0n;
    for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
    let code = "";
    for (let shift = 35n; shift >= 0n; shift -= 5n) {
        code += CROCKFORD[Number((bits >> shift) & 31n)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}
