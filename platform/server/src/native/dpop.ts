import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { sha256Base64Url } from "@lucent/core/scalars";
import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify } from "jose";
import { z } from "zod";
import { type DbFailure, execute, type Queryable, sql } from "../db/pool.ts";

// DPoP (RFC 9449) with the device key: every native request is signed by the PC's P-256 key (TPM
// or CNG software), so enrollment, sign-in and every later call share one proof of the PC. No
// server nonces: freshness is the proof's `iat` against the database's clock (at most 5 s ahead,
// 300 s behind; the loader corrects for its own offset from our `Date` header and retries once),
// and each `jti` is accepted once while its `iat` is in the window.

const MAX_AHEAD_SECONDS = 5;
const MAX_BEHIND_SECONDS = 300;
const MAX_PROOF_LENGTH = 4_096;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

// Exactly the public members: jose refuses a private key in the header itself, and anything else
// (another curve, kty) never reaches the thumbprint.
export const DevicePublicKey = z.strictObject({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: Base64Url.length(43),
    y: Base64Url.length(43),
});
export type DevicePublicKey = z.output<typeof DevicePublicKey>;

const ProofHeader = z.object({ jwk: DevicePublicKey });

const ProofClaims = z.object({
    jti: z.string().regex(/^[\x21-\x7e]{16,128}$/),
    htm: z.string(),
    htu: z.string(),
    iat: z.number().int().nonnegative(),
    ath: Base64Url.optional(),
});

export type DpopProof = {
    // The key's RFC 7638 SHA-256 thumbprint, base64url: what devices and tokens are bound to.
    readonly jkt: string;
    readonly key: DevicePublicKey;
    readonly jti: string;
    readonly iat: number;
};

export type ProofInvalid = { readonly code: "PROOF_INVALID" };

const invalid = (): Result<never, ProofInvalid> => err({ code: "PROOF_INVALID" });

// The proof's signature, shape and binding to this request. `htu` is the public URL the loader
// addressed, which behind Caddy isn't the one this process sees. With an access token, `ath` must
// be its hash, so a proof can't be lifted onto another token.
export async function verifyProof(params: {
    readonly header: string | null;
    readonly method: string;
    readonly url: string;
    readonly accessToken: string | null;
}): Promise<Result<DpopProof, ProofInvalid>> {
    const { header } = params;
    if (header === null || header.length > MAX_PROOF_LENGTH) return invalid();
    const verified = await tryAsync(
        () => jwtVerify(header, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ["ES256"] }),
        () => ({ code: "PROOF_INVALID" as const }),
    );
    if (!verified.ok) return verified;
    const protectedHeader = ProofHeader.safeParse(verified.value.protectedHeader);
    const claims = ProofClaims.safeParse(verified.value.payload);
    if (!protectedHeader.success || !claims.success) return invalid();
    const { htm, htu, ath, jti, iat } = claims.data;
    if (htm !== params.method || htu !== params.url) return invalid();
    if (params.accessToken !== null && ath !== (await sha256Base64Url(params.accessToken))) {
        return invalid();
    }
    const key = protectedHeader.data.jwk;
    return ok({ jkt: await calculateJwkThumbprint(key), key, jti, iat });
}

// Inside the window by the database's clock, and never seen: one statement, so two requests
// racing with the same proof can't both pass.
export async function acceptFresh(
    q: Queryable,
    proof: DpopProof,
): Promise<Result<void, ProofInvalid | DbFailure>> {
    const inserted = await execute(
        q,
        sql`insert into dpop_proof (jkt, jti, expires_at)
            select ${proof.jkt}, ${proof.jti},
                   to_timestamp(${proof.iat}) + make_interval(secs => ${MAX_BEHIND_SECONDS + MAX_AHEAD_SECONDS})
            where to_timestamp(${proof.iat}) <= now() + make_interval(secs => ${MAX_AHEAD_SECONDS})
              and to_timestamp(${proof.iat}) >= now() - make_interval(secs => ${MAX_BEHIND_SECONDS})
            on conflict do nothing`,
    );
    if (!inserted.ok) return inserted;
    return inserted.value === 1 ? ok(undefined) : invalid();
}
