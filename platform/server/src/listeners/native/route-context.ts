import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { Clock } from "@lucent/core/clock";
import { containBoundary } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { BearerToken } from "@lucent/core/scalars";
import type { Context } from "hono";
import type { Logger } from "../../core/log.ts";
import type { Db } from "../../db/pool.ts";
import { resolveAccessToken, type TokenHolder } from "../../devices/sign-in.ts";
import type { LeaseSigner } from "../../runtime/lease-key.ts";
import { acceptFresh, type DpopProof, verifyProof } from "./dpop.ts";
import {
    MAX_NATIVE_BODY_BYTES,
    type NativeRefusal,
    readBoundedBody,
    refusalResponse,
} from "./http.ts";
import { createRateLimiter, type RateRule } from "./rate-limit.ts";
import { oauthReply, refusalOf } from "./responses.ts";

// The loaders' listener (`api.lucent.moe`): native /v1 only, no cookies, no CORS, no HTML. Every
// request but the two OAuth endpoints carries a DPoP-bound access token; every refusal is the
// binary refusal body; anything unexpected is 503, never 500.

export type NativeDeps = {
    readonly db: Db;
    readonly rng: CryptoRng;
    // Rate limits only: every eligibility decision uses the database's clock.
    readonly clock: Clock;
    readonly catalog: ProductCatalog;
    readonly signer: LeaseSigner;
    // The public origin loaders address, which their DPoP proofs name.
    readonly origin: string;
    // Where ops wrote the loader's and host's bytes, one file per BLAKE2b-256 hex digest.
    readonly artifactDir: string;
    readonly isSuperseded: () => boolean;
    readonly logger: Logger;
    readonly rateLimits?: Readonly<Record<string, RateRule>>;
};

// Per device key, per minute. Renewals come every 15 s and polls every few seconds; the rest is a
// handful per game start.
export const DEFAULT_RATE_LIMITS: Readonly<Record<string, RateRule>> = {
    "auth.requests": { perMinute: 10 },
    "auth.token": { perMinute: 30 },
    "enrollments.create": { perMinute: 10 },
    "enrollments.read": { perMinute: 60 },
    "starts.create": { perMinute: 20 },
    "starts.container": { perMinute: 20 },
    "sessions.open": { perMinute: 20 },
    "sessions.lease": { perMinute: 20 },
    "sessions.data": { perMinute: 60 },
    "sessions.close": { perMinute: 20 },
    "loader.seal": { perMinute: 20 },
    "artifacts.read": { perMinute: 20 },
};

export function createRouteContext(deps: NativeDeps) {
    const limiter = createRateLimiter({
        clock: deps.clock,
        rules: deps.rateLimits ?? DEFAULT_RATE_LIMITS,
    });

    const unavailable = async (detail: string, kind: string) => {
        await containBoundary({
            run: () => {
                deps.logger.write("error", kind, { origin: "native", detail });
                return Promise.resolve();
            },
            onUnhandled: () => undefined,
        });
        return refusalResponse({ code: "SERVICE_UNAVAILABLE" });
    };

    const publicUrl = (c: Context): string => `${deps.origin}${new URL(c.req.url).pathname}`;

    // The proof for this exact request, rate-limited by the key that signed it, fresh and unseen.
    const proven = async (
        c: Context,
        route: string,
        accessToken: string | null,
    ): Promise<Result<DpopProof, NativeRefusal>> => {
        const proof = await verifyProof({
            header: c.req.header("dpop") ?? null,
            method: c.req.method,
            url: publicUrl(c),
            accessToken,
        });
        if (!proof.ok) return proof;
        const allowed = limiter.take(route, proof.value.jkt);
        if (!allowed.ok) return allowed;
        const fresh = await acceptFresh(deps.db, proof.value);
        if (!fresh.ok) return err(refusalOf(fresh.error));
        return proof;
    };

    type Caller = { readonly holder: TokenHolder; readonly proof: DpopProof };

    const authenticated = async (
        c: Context,
        route: string,
    ): Promise<Result<Caller, NativeRefusal>> => {
        const match = /^DPoP (\S+)$/.exec(c.req.header("authorization") ?? "");
        const token = BearerToken.safeParse(match?.[1]);
        if (!token.success) return err({ code: "AUTH_REQUIRED" });
        const proof = await proven(c, route, token.data);
        if (!proof.ok) return proof;
        const holder = await resolveAccessToken(deps.db, { token: token.data, proof: proof.value });
        if (!holder.ok) return err(refusalOf(holder.error));
        return ok({ holder: holder.value, proof: proof.value });
    };

    const body = async (
        c: Context,
        maxBytes = MAX_NATIVE_BODY_BYTES,
    ): Promise<Result<Uint8Array<ArrayBuffer>, NativeRefusal>> => {
        const read = await readBoundedBody(c.req.raw, maxBytes);
        return read.ok ? read : err({ code: "INVALID_REQUEST" });
    };

    // The OAuth endpoints answer in OAuth's words (RFC 6749 §5.2, RFC 9449 §7.1).
    const oauthProven = async (c: Context, route: string): Promise<Result<DpopProof, Response>> => {
        const proof = await proven(c, route, null);
        if (proof.ok) return proof;
        const { code } = proof.error;
        if (code === "RATE_LIMITED") {
            const seconds = String(Math.ceil((proof.error.retryAfterMs ?? 0) / 1_000));
            return err(oauthReply(429, { error: "slow_down" }, { "retry-after": seconds }));
        }
        if (code === "SERVICE_UNAVAILABLE")
            return err(oauthReply(503, { error: "temporarily_unavailable" }));
        return err(oauthReply(400, { error: "invalid_dpop_proof" }));
    };

    return { deps, unavailable, authenticated, body, oauthProven };
}

export type NativeRoutes = ReturnType<typeof createRouteContext>;
