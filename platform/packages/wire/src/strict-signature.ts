import { isSignedBy } from "@lucent/bundle/crypto";

// Strict Ed25519 verification, the twin of native/libs/crypto's verify(): Bun 1.4.4's WebCrypto
// refuses an unreduced S and a non-canonical R, but decodes a non-canonical key and checks neither
// the key nor R for small order (contracts/ed25519/v1/strict.json has a case for each). The
// decided rule is strict verification on both sides, so this check runs before WebCrypto's.

const FIELD_PRIME = (1n << 255n) - 19n;
const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

// The y coordinates (sign bit cleared) of the eight points of small order, in every encoding a lax
// decoder accepts: 0 (order 4), 1 (the identity), the two y of order 8, p - 1 (order 2), and p and
// p + 1, which reduce to 0 and 1.
// found: libsodium's ge25519_has_small_order (crypto_core/ed25519/ref10/ed25519_ref10.c), the same
// list as native/libs/crypto/src/crypto.cpp's.
const SMALL_ORDER_Y = new Set([
    0n,
    1n,
    BigInt("0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826"),
    BigInt("0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7"),
    FIELD_PRIME - 1n,
    FIELD_PRIME,
    FIELD_PRIME + 1n,
]);

function littleEndian(bytes: Uint8Array): bigint {
    return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

// One encoding per point: y below p, and no sign bit where x is 0 (y = 1 and y = p - 1).
function isCanonicalPoint(point: Uint8Array): boolean {
    const encoded = littleEndian(point);
    const y = encoded & ((1n << 255n) - 1n);
    const hasSign = encoded >> 255n === 1n;
    return y < FIELD_PRIME && !(hasSign && (y === 1n || y === FIELD_PRIME - 1n));
}

function isSmallOrder(point: Uint8Array): boolean {
    return SMALL_ORDER_Y.has(littleEndian(point) & ((1n << 255n) - 1n));
}

export function isStrictSignatureShape(publicKey: Uint8Array, signature: Uint8Array): boolean {
    if (publicKey.byteLength !== 32 || signature.byteLength !== 64) {
        return false;
    }
    const nonce = signature.subarray(0, 32);
    return (
        littleEndian(signature.subarray(32)) < GROUP_ORDER &&
        isCanonicalPoint(publicKey) &&
        isCanonicalPoint(nonce) &&
        !isSmallOrder(publicKey) &&
        !isSmallOrder(nonce)
    );
}

// Whether `signature` is `publicKey`'s over exactly `message`, under the strict rules.
export async function isStrictlySignedBy(
    publicKey: Uint8Array,
    message: Uint8Array,
    signature: Uint8Array,
): Promise<boolean> {
    if (!isStrictSignatureShape(publicKey, signature)) {
        return false;
    }
    return await isSignedBy(publicKey, message, signature);
}
