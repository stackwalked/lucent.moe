import { join } from "node:path";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { Clock } from "@lucent/core/clock";
import { containBoundary } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import { BearerToken } from "@lucent/core/scalars";
import { encryptedSize, toEncryptedContainerStream } from "@lucent/wire/container-stream";
import { parseEnrollmentRequest, toEnrollmentStatusBytes } from "@lucent/wire/enrollment";
import { parseLeaseRequest } from "@lucent/wire/lease-exchange";
import type { RefusalCode } from "@lucent/wire/refusal";
import { parseSessionHello } from "@lucent/wire/session";
import { parseStartRequest, toStartReplyBytes } from "@lucent/wire/start";
import { type Context, Hono } from "hono";
import type { Logger } from "../core/log.ts";
import type { Db, DbFailure } from "../db/pool.ts";
import { readEnrollment, requestEnrollment } from "./devices.ts";
import { acceptFresh, type DpopProof, verifyProof } from "./dpop.ts";
import {
    binaryResponse,
    type NativeRefusal,
    operationIdOf,
    parseIdSegment,
    readBoundedBody,
    refusalResponse,
} from "./http.ts";
import type { LeaseSigner } from "./lease-key.ts";
import { checkLoaderArtifact, readLoaderSeal } from "./loader.ts";
import { createRateLimiter, type RateRule } from "./rate-limit.ts";
import { closeSession, openSession, renewLease } from "./sessions.ts";
import {
    type OAuthError,
    parseForm,
    pushAuthRequest,
    redeemCode,
    refreshTokens,
    resolveAccessToken,
    type TokenHolder,
    type TokenSet,
} from "./sign-in.ts";
import { createStart, readStartContainer } from "./starts.ts";

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
    "sessions.close": { perMinute: 20 },
    "loader.seal": { perMinute: 20 },
    "artifacts.read": { perMinute: 20 },
};

type ServerFault = DbFailure | { readonly code: "RECEIPT_UNREADABLE" };

const FAULT_CODES: ReadonlySet<string> = new Set([
    "STATEMENT_TIMEOUT",
    "SERIALIZATION_FAILURE",
    "UNIQUE_VIOLATION",
    "CHECK_VIOLATION",
    "DB_UNAVAILABLE",
    "RECEIPT_UNREADABLE",
]);

function isFault<E extends { readonly code: string }>(
    error: E | ServerFault,
): error is ServerFault {
    return FAULT_CODES.has(error.code);
}

// A refusal for the loader to show, or the server's own failure as 503.
function refusalOf(error: { readonly code: RefusalCode } | ServerFault): NativeRefusal {
    if (isFault(error)) return { code: "SERVICE_UNAVAILABLE" };
    return { code: error.code };
}

function reply<T>(
    result: Result<T, { readonly code: RefusalCode } | ServerFault>,
    respond: (value: T) => Response,
): Response {
    return result.ok ? respond(result.value) : refusalResponse(refusalOf(result.error));
}

function oauthReply(
    status: number,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
): Response {
    return Response.json(body, {
        status,
        headers: { "cache-control": "no-store", pragma: "no-cache", ...headers },
    });
}

function oauthFailure(error: OAuthError | ServerFault): Response {
    if (isFault(error)) return oauthReply(503, { error: "temporarily_unavailable" });
    return oauthReply(error.code === "invalid_client" ? 401 : 400, { error: error.code });
}

function tokenReply(tokens: TokenSet): Response {
    return oauthReply(200, {
        access_token: tokens.accessToken,
        token_type: "DPoP",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
    });
}

const FORM_FIELDS = {
    request: [
        "client_id",
        "response_type",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "state",
    ],
    token: ["client_id", "grant_type", "code", "code_verifier", "redirect_uri", "refresh_token"],
} as const;

export function createNativeApp(deps: NativeDeps): Hono {
    const app = new Hono();
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

    // Hono routes thrown Errors to onError but rethrows anything else (invariant defects are plain
    // objects) out of fetch; the outermost middleware contains those.
    app.onError((cause) => unavailable(cause.message, "exception"));
    app.use("*", async (_c, next) => {
        const contained = await containBoundary({
            run: async () => {
                await next();
                return null;
            },
            onUnhandled: (detail, kind) => unavailable(detail, kind),
        });
        return contained ?? undefined;
    });
    app.use("*", async (_c, next) => {
        if (deps.isSuperseded()) return refusalResponse({ code: "SERVICE_UNAVAILABLE" });
        return await next();
    });

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

    const body = async (c: Context): Promise<Result<Uint8Array<ArrayBuffer>, NativeRefusal>> => {
        const read = await readBoundedBody(c.req.raw);
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

    const formOf = async (
        c: Context,
        fields: readonly string[],
    ): Promise<ReadonlyMap<string, string> | null> => {
        if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
            return null;
        }
        const read = await readBoundedBody(c.req.raw);
        return read.ok ? parseForm(read.value, fields) : null;
    };

    app.post("/v1/auth/requests", async (c) => {
        const proof = await oauthProven(c, "auth.requests");
        if (!proof.ok) return proof.error;
        const form = await formOf(c, FORM_FIELDS.request);
        if (form === null) return oauthReply(400, { error: "invalid_request" });
        const pushed = await pushAuthRequest(deps.db, { rng: deps.rng, proof: proof.value, form });
        if (!pushed.ok) return oauthFailure(pushed.error);
        return oauthReply(201, {
            request_uri: pushed.value.requestUri,
            expires_in: pushed.value.expiresInSeconds,
        });
    });

    app.post("/v1/auth/token", async (c) => {
        const proof = await oauthProven(c, "auth.token");
        if (!proof.ok) return proof.error;
        const form = await formOf(c, FORM_FIELDS.token);
        if (form === null) return oauthReply(400, { error: "invalid_request" });
        const grant = { rng: deps.rng, proof: proof.value, form };
        switch (form.get("grant_type")) {
            case "authorization_code": {
                const tokens = await redeemCode(deps.db, grant);
                return tokens.ok ? tokenReply(tokens.value) : oauthFailure(tokens.error);
            }
            case "refresh_token": {
                const tokens = await refreshTokens(deps.db, grant);
                return tokens.ok ? tokenReply(tokens.value) : oauthFailure(tokens.error);
            }
            default:
                return oauthReply(400, { error: "unsupported_grant_type" });
        }
    });

    app.post("/v1/enrollments", async (c) => {
        const caller = await authenticated(c, "enrollments.create");
        if (!caller.ok) return refusalResponse(caller.error);
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseEnrollmentRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const status = await requestEnrollment(deps.db, {
            rng: deps.rng,
            ...caller.value,
            storage: request.value.storage,
            operationId,
        });
        return reply(status, (value) => binaryResponse(toEnrollmentStatusBytes(value)));
    });

    app.get("/v1/enrollments/:id", async (c) => {
        const caller = await authenticated(c, "enrollments.read");
        if (!caller.ok) return refusalResponse(caller.error);
        const enrollmentId = parseIdSegment(c.req.param("id"));
        if (enrollmentId === null) return refusalResponse({ code: "NOT_FOUND" });
        const status = await readEnrollment(deps.db, { ...caller.value, enrollmentId });
        return reply(status, (value) => binaryResponse(toEnrollmentStatusBytes(value)));
    });

    app.post("/v1/starts", async (c) => {
        const caller = await authenticated(c, "starts.create");
        if (!caller.ok) return refusalResponse(caller.error);
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseStartRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const started = await createStart(deps.db, {
            rng: deps.rng,
            catalog: deps.catalog,
            ...caller.value,
            request: request.value,
            operationId,
        });
        return reply(started, (value) => binaryResponse(toStartReplyBytes(value)));
    });

    app.get("/v1/starts/:id/container", async (c) => {
        const caller = await authenticated(c, "starts.container");
        if (!caller.ok) return refusalResponse(caller.error);
        const startId = parseIdSegment(c.req.param("id"));
        if (startId === null) return refusalResponse({ code: "NOT_FOUND" });
        const found = await readStartContainer(deps.db, { ...caller.value, startId });
        return reply(
            found,
            (start) =>
                new Response(
                    toEncryptedContainerStream({
                        key: start.key,
                        container: start.container,
                        rng: deps.rng,
                    }),
                    {
                        headers: {
                            "content-type": "application/octet-stream",
                            "content-length": String(encryptedSize(start.container.byteLength)),
                            "cache-control": "no-store",
                        },
                    },
                ),
        );
    });

    app.post("/v1/starts/:id/session", async (c) => {
        const caller = await authenticated(c, "sessions.open");
        if (!caller.ok) return refusalResponse(caller.error);
        const startId = parseIdSegment(c.req.param("id"));
        if (startId === null) return refusalResponse({ code: "NOT_FOUND" });
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const hello = parseSessionHello(bytes.value);
        if (operationId === null || !hello.ok) return refusalResponse({ code: "INVALID_REQUEST" });
        const opened = await openSession(deps.db, {
            rng: deps.rng,
            catalog: deps.catalog,
            signer: deps.signer,
            ...caller.value,
            startId,
            hello: hello.value,
            operationId,
        });
        return reply(opened, (bytesOut) => binaryResponse(bytesOut));
    });

    app.post("/v1/sessions/:id/lease", async (c) => {
        const caller = await authenticated(c, "sessions.lease");
        if (!caller.ok) return refusalResponse(caller.error);
        const sessionId = parseIdSegment(c.req.param("id"));
        if (sessionId === null) return refusalResponse({ code: "NOT_FOUND" });
        const operationId = operationIdOf(c.req.raw);
        const bytes = await body(c);
        if (!bytes.ok) return refusalResponse(bytes.error);
        const request = parseLeaseRequest(bytes.value);
        if (operationId === null || !request.ok)
            return refusalResponse({ code: "INVALID_REQUEST" });
        const renewed = await renewLease(deps.db, {
            rng: deps.rng,
            signer: deps.signer,
            ...caller.value,
            sessionId,
            request: request.value,
            body: bytes.value,
            operationId,
        });
        return reply(renewed, (bytesOut) => binaryResponse(bytesOut));
    });

    app.post("/v1/sessions/:id/close", async (c) => {
        const caller = await authenticated(c, "sessions.close");
        if (!caller.ok) return refusalResponse(caller.error);
        const sessionId = parseIdSegment(c.req.param("id"));
        if (sessionId === null) return refusalResponse({ code: "NOT_FOUND" });
        const closed = await closeSession(deps.db, { ...caller.value, sessionId });
        return reply(closed, () => new Response(null, { status: 204 }));
    });

    app.get("/v1/loader", async (c) => {
        const caller = await authenticated(c, "loader.seal");
        if (!caller.ok) return refusalResponse(caller.error);
        const seal = await readLoaderSeal(deps.db, {
            catalog: deps.catalog,
            accountId: caller.value.holder.accountId,
        });
        return reply(seal, (bytes) => binaryResponse(new Uint8Array(bytes)));
    });

    app.get("/v1/artifacts/:digest", async (c) => {
        const caller = await authenticated(c, "artifacts.read");
        if (!caller.ok) return refusalResponse(caller.error);
        const digest = c.req.param("digest");
        if (!/^[0-9a-f]{64}$/.test(digest)) return refusalResponse({ code: "NOT_FOUND" });
        const offered = await checkLoaderArtifact(deps.db, {
            catalog: deps.catalog,
            accountId: caller.value.holder.accountId,
            digest,
        });
        if (!offered.ok) return refusalResponse(refusalOf(offered.error));
        // Only the validated digest names a file; the bytes were written by ops, never by a request.
        const file = Bun.file(join(deps.artifactDir, digest));
        if (!(await file.exists())) {
            return await unavailable(
                `no file for the current artifact ${digest}`,
                "artifact_missing",
            );
        }
        return new Response(file.stream(), {
            headers: {
                "content-type": "application/octet-stream",
                "content-length": String(file.size),
                "cache-control": "no-store",
            },
        });
    });

    app.notFound(() => refusalResponse({ code: "NOT_FOUND" }));
    return app;
}
