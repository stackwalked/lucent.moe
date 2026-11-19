import { invariant } from "@lucent/core/contain";
import type { CryptoRng } from "@lucent/core/rng";
import { toBase64Url } from "@lucent/core/scalars";
import type {
    AuthenticationResponse,
    CreationOptions,
    RegistrationResponse,
    RequestOptions,
} from "@lucent/rpc/webauthn";
import type { z } from "zod";
import type { RelyingParty } from "../../src/auth/passkeys.ts";

export const TEST_RELYING_PARTY: RelyingParty = {
    rpId: "lucent.test",
    rpName: "lucent.moe",
    origin: "https://lucent.test",
};

// Just enough CBOR (RFC 8949) for a "none" attestation object and a COSE EC2 key.
type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor>;

function cborHead(major: number, length: number): number[] {
    if (length < 24) return [(major << 5) | length];
    if (length < 0x100) return [(major << 5) | 24, length];
    invariant(length < 0x10000, "test CBOR item too long");
    return [(major << 5) | 25, length >> 8, length & 0xff];
}

function encodeCbor(value: Cbor): number[] {
    if (typeof value === "number") {
        return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    }
    if (typeof value === "string") {
        const bytes = new TextEncoder().encode(value);
        return [...cborHead(3, bytes.byteLength), ...bytes];
    }
    if (value instanceof Uint8Array) return [...cborHead(2, value.byteLength), ...value];
    const out = cborHead(5, value.size);
    for (const [key, item] of value) out.push(...encodeCbor(key), ...encodeCbor(item));
    return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
}

function clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
}

// WebCrypto signs ECDSA as raw r||s; WebAuthn carries an ASN.1 DER SEQUENCE of two INTEGERs.
function derSignature(raw: Uint8Array): Uint8Array {
    const integer = (part: Uint8Array): number[] => {
        let start = 0;
        while (start < part.byteLength - 1 && part[start] === 0) start++;
        const body = [...part.slice(start)];
        if ((body[0] ?? 0) & 0x80) body.unshift(0);
        return [0x02, body.length, ...body];
    };
    const r = integer(raw.slice(0, 32));
    const s = integer(raw.slice(32, 64));
    return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

function u32(value: number): number[] {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// A platform authenticator in software, holding one P-256 passkey. It answers the options the
// server sends exactly as a browser would hand them back, so tests exercise the real verifier.
export type TestAuthenticator = {
    readonly credentialId: Uint8Array;
    readonly register: (
        options: CreationOptions,
        overrides?: { readonly origin?: string },
    ) => Promise<z.input<typeof RegistrationResponse>>;
    readonly assert: (
        options: RequestOptions,
        overrides?: { readonly origin?: string; readonly signCount?: number },
    ) => Promise<z.input<typeof AuthenticationResponse>>;
};

export async function createTestAuthenticator(params: {
    readonly rng: CryptoRng;
    readonly rp?: RelyingParty;
}): Promise<TestAuthenticator> {
    const rp = params.rp ?? TEST_RELYING_PARTY;
    const credentialId = params.rng.fillBytes(new Uint8Array(16));
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    invariant(jwk.x !== undefined && jwk.y !== undefined, "an EC public JWK has x and y");
    const coseKey = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Uint8Array.fromBase64(jwk.x, { alphabet: "base64url" })],
        [-3, Uint8Array.fromBase64(jwk.y, { alphabet: "base64url" })],
    ]);
    let signCount = 0;
    const rpIdHash = await sha256(new TextEncoder().encode(rp.rpId));
    const id = toBase64Url(credentialId);

    return {
        credentialId,
        register(options, overrides) {
            const authData = Uint8Array.from([
                ...rpIdHash,
                FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_DATA,
                ...u32(signCount),
                ...new Uint8Array(16),
                credentialId.byteLength >> 8,
                credentialId.byteLength & 0xff,
                ...credentialId,
                ...encodeCbor(coseKey),
            ]);
            const attestationObject = Uint8Array.from(
                encodeCbor(
                    new Map<Cbor, Cbor>([
                        ["fmt", "none"],
                        ["attStmt", new Map()],
                        ["authData", authData],
                    ]),
                ),
            );
            const data = clientData(
                "webauthn.create",
                options.challenge,
                overrides?.origin ?? rp.origin,
            );
            return Promise.resolve({
                id,
                rawId: id,
                type: "public-key",
                clientExtensionResults: {},
                response: {
                    clientDataJSON: toBase64Url(data),
                    attestationObject: toBase64Url(attestationObject),
                    transports: ["internal"],
                },
            });
        },
        async assert(options, overrides) {
            signCount = overrides?.signCount ?? signCount + 1;
            const authData = Uint8Array.from([
                ...rpIdHash,
                FLAG_USER_PRESENT | FLAG_USER_VERIFIED,
                ...u32(signCount),
            ]);
            const data = clientData(
                "webauthn.get",
                options.challenge,
                overrides?.origin ?? rp.origin,
            );
            const signed = Uint8Array.from([...authData, ...(await sha256(data))]);
            const raw = new Uint8Array(
                await crypto.subtle.sign(
                    { name: "ECDSA", hash: "SHA-256" },
                    keys.privateKey,
                    signed,
                ),
            );
            return {
                id,
                rawId: id,
                type: "public-key",
                clientExtensionResults: {},
                response: {
                    clientDataJSON: toBase64Url(data),
                    authenticatorData: toBase64Url(authData),
                    signature: toBase64Url(derSignature(raw)),
                },
            };
        },
    };
}
