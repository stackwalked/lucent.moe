import { toReleaseManifestV2Bytes } from "@lucent/bundle/release-manifest";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { type Clock, systemClock } from "@lucent/core/clock";
import { invariant, trySync } from "@lucent/core/contain";
import type { SeededRng } from "@lucent/core/rng";
import {
    type AccountId,
    type BearerToken,
    ChannelId,
    EpochMs,
    FeatureTag,
    newOperationId,
    ProductId,
    sha256Base64Url,
    toBase64Url,
    toHex,
} from "@lucent/core/scalars";
import { parseEnrollmentStatus, toEnrollmentRequestBytes } from "@lucent/wire/enrollment";
import { openFrame, sealFrame } from "@lucent/wire/frame";
import {
    CHALLENGE_ANSWER_SIZE,
    type Lease,
    parseLease,
    SIGNALS_SIZE,
    toLeaseRenewalBytes,
    toLeaseSignedBytes,
} from "@lucent/wire/lease";
import { parseLeaseResponse, toLeaseRequestBytes } from "@lucent/wire/lease-exchange";
import { parseRefusal, type RefusalCode } from "@lucent/wire/refusal";
import {
    deriveSessionKeys,
    parseSessionReply,
    type SessionKeys,
    toExchangeSignedBytes,
    toSessionHelloBytes,
} from "@lucent/wire/session";
import { exchangePublicKey, sharedSecret } from "@lucent/wire/session-crypto";
import { type Channel, parseStartReply, toStartRequestBytes } from "@lucent/wire/start";
import { isStrictlySignedBy } from "@lucent/wire/strict-signature";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { calculateJwkThumbprint, SignJWT } from "jose";
import { z } from "zod";
import { issueEntitlement } from "../src/authority/writers.ts";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { createNativeApp, DEFAULT_RATE_LIMITS } from "../src/native/app.ts";
import {
    CHUNK_NONCE_SIZE,
    CHUNK_TAG_SIZE,
    CONTAINER_CHUNK_SIZE,
    toChunkAssociatedData,
} from "../src/native/container.ts";
import { approveEnrollment } from "../src/native/devices.ts";
import { createLeaseSigner, type LeaseSigner } from "../src/native/lease-key.ts";
import type { RateRule } from "../src/native/rate-limit.ts";
import { decideSignInRequest, SignInRequestId } from "../src/native/sign-in.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, seedAccount, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";

export const ORIGIN = "https://api.lucent.test";
// A fixed lease key: tests check signatures against its public half, as a module would.
export const LEASE_SEED = new Uint8Array(32).fill(7);

export type NativeHarness = {
    readonly db: Db;
    readonly rng: SeededRng;
    readonly catalog: ProductCatalog;
    readonly signer: LeaseSigner;
    readonly fetch: (req: Request) => Promise<Response>;
};

export async function createNativeHarness(
    db: Db,
    rng: SeededRng,
    options?: { readonly clock?: Clock; readonly rateLimits?: Readonly<Record<string, RateRule>> },
): Promise<NativeHarness> {
    const products = catalog();
    const signer = await createLeaseSigner(LEASE_SEED);
    const app = createNativeApp({
        db,
        rng,
        clock: options?.clock ?? systemClock,
        catalog: products,
        signer,
        origin: ORIGIN,
        isSuperseded: () => false,
        logger: { write: () => {} },
        rateLimits: options?.rateLimits ?? DEFAULT_RATE_LIMITS,
    });
    return {
        db,
        rng,
        catalog: products,
        signer,
        fetch: async (req) => await app.fetch(req),
    };
}

// A PC's P-256 device key, in software, and the DPoP proofs it signs.
export type TestDevice = {
    readonly jwk: {
        readonly kty: "EC";
        readonly crv: "P-256";
        readonly x: string;
        readonly y: string;
    };
    readonly jkt: string;
    readonly proof: (params: {
        readonly method: string;
        readonly path: string;
        readonly accessToken?: string;
        // Seconds since the epoch; now by default.
        readonly iat?: number;
        readonly jti?: string;
    }) => Promise<string>;
};

export async function createTestDevice(rng: SeededRng): Promise<TestDevice> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
    invariant(exported.x !== undefined && exported.y !== undefined, "an EC JWK has x and y");
    const jwk = { kty: "EC", crv: "P-256", x: exported.x, y: exported.y } as const;
    return {
        jwk,
        jkt: await calculateJwkThumbprint(jwk),
        proof: async (params) => {
            const claims: Record<string, unknown> = {
                jti: params.jti ?? toBase64Url(rng.fillBytes(new Uint8Array(16))),
                htm: params.method,
                htu: `${ORIGIN}${params.path}`,
                iat: params.iat ?? Math.floor(systemClock.now() / 1_000),
            };
            if (params.accessToken !== undefined) {
                claims["ath"] = await sha256Base64Url(params.accessToken);
            }
            return await new SignJWT(claims)
                .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
                .sign(keys.privateKey);
        },
    };
}

export type Sent = {
    readonly status: number;
    readonly bytes: Uint8Array;
};

export function refusalCodeOf(sent: Sent): RefusalCode | "NOT_A_REFUSAL" {
    const parsed = parseRefusal(sent.bytes);
    if (!parsed.ok || typeof parsed.value.code !== "string") return "NOT_A_REFUSAL";
    return parsed.value.code;
}

const TokenReply = z.strictObject({
    access_token: z.string(),
    token_type: z.literal("DPoP"),
    expires_in: z.literal(300),
    refresh_token: z.string(),
});

// The loader's side of the wire: its device key, its tokens, and requests as it sends them.
export type TestLoader = {
    readonly device: TestDevice;
    readonly accessToken: () => string;
    readonly refreshToken: () => string;
    readonly send: (params: {
        readonly method: "GET" | "POST";
        readonly path: string;
        readonly body?: Uint8Array;
        readonly operationId?: string | null;
        readonly iat?: number;
    }) => Promise<Sent>;
    readonly form: (
        path: string,
        fields: Record<string, string>,
    ) => Promise<{ readonly status: number; readonly json: unknown }>;
    readonly useTokens: (tokens: { readonly access: string; readonly refresh: string }) => void;
};

export function createTestLoader(harness: NativeHarness, device: TestDevice): TestLoader {
    let access = "";
    let refresh = "";
    return {
        device,
        accessToken: () => access,
        refreshToken: () => refresh,
        send: async (params) => {
            const headers: Record<string, string> = {
                authorization: `DPoP ${access}`,
                dpop: await device.proof({
                    method: params.method,
                    path: params.path,
                    accessToken: access,
                    ...(params.iat === undefined ? {} : { iat: params.iat }),
                }),
            };
            const operationId =
                params.operationId === undefined ? newOperationId(harness.rng) : params.operationId;
            if (operationId !== null) headers["lucent-operation"] = operationId;
            const res = await harness.fetch(
                new Request(`http://127.0.0.1:4711${params.path}`, {
                    method: params.method,
                    headers,
                    ...(params.body === undefined ? {} : { body: params.body }),
                }),
            );
            return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
        },
        form: async (path, fields) => {
            const res = await harness.fetch(
                new Request(`http://127.0.0.1:4711${path}`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        dpop: await device.proof({ method: "POST", path }),
                    },
                    body: new URLSearchParams(fields).toString(),
                }),
            );
            return { status: res.status, json: await res.json() };
        },
        useTokens: (tokens) => {
            access = tokens.access;
            refresh = tokens.refresh;
        },
    };
}

export const REDIRECT_URI = "http://127.0.0.1:53682/callback";

// The whole sign-in as loader and browser do it: push, approve in the browser, redeem the code
// on the loopback callback with the PKCE verifier.
export async function signIn(
    harness: NativeHarness,
    loader: TestLoader,
    browserSession: BearerToken,
): Promise<void> {
    const verifier = toBase64Url(harness.rng.fillBytes(new Uint8Array(32)));
    const state = toBase64Url(harness.rng.fillBytes(new Uint8Array(16)));
    const pushed = await loader.form("/v1/auth/requests", {
        client_id: "lucent-loader",
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        state,
    });
    invariant(pushed.status === 201, `pushing the request failed: ${JSON.stringify(pushed)}`);
    const requestUri = z.object({ request_uri: z.string() }).parse(pushed.json).request_uri;
    const requestId = SignInRequestId.parse(requestUri.split(":").at(-1));
    const decided = await decideSignInRequest(harness.db, {
        rng: harness.rng,
        sessionToken: browserSession,
        requestId,
        decision: "approve",
    });
    invariant(decided.ok, `approving the sign-in failed: ${JSON.stringify(decided)}`);
    const callback = new URL(decided.value.redirectTo);
    invariant(callback.searchParams.get("state") === state, "the callback carries the state");
    const redeemed = await loader.form("/v1/auth/token", {
        client_id: "lucent-loader",
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
    });
    invariant(redeemed.status === 200, `redeeming the code failed: ${JSON.stringify(redeemed)}`);
    const tokens = TokenReply.parse(redeemed.json);
    loader.useTokens({ access: tokens.access_token, refresh: tokens.refresh_token });
}

// Enrolls the loader's key: its request, the member's approval in a fresh browser session, and
// the device id from its poll.
export async function enroll(
    harness: NativeHarness,
    loader: TestLoader,
    browserSession: BearerToken,
): Promise<Uint8Array> {
    const requested = await loader.send({
        method: "POST",
        path: "/v1/enrollments",
        body: toEnrollmentRequestBytes({ storage: "tpm" }),
    });
    const pending = parseEnrollmentStatus(requested.bytes);
    invariant(pending.ok, `enrolling failed: ${refusalCodeOf(requested)}`);
    const approved = await approveEnrollment(harness.db, {
        rng: harness.rng,
        sessionToken: browserSession,
        operationId: newOperationId(harness.rng),
        enrollmentId: pending.value.enrollment,
    });
    invariant(approved.ok, `approving the enrollment failed: ${JSON.stringify(approved)}`);
    return Uint8Array.fromHex(approved.value.deviceId);
}

export type Member = {
    readonly accountId: AccountId;
    readonly browserSession: BearerToken;
};

// An account entitled to cs2 on `channels` (every feature unless `features` names some), holding
// a fresh member session.
export async function entitledMember(
    harness: NativeHarness,
    params: {
        readonly email: string;
        readonly channels: readonly string[];
        readonly features?: readonly string[];
    },
): Promise<Member> {
    const { db, rng } = harness;
    const rootId = await seedRootOnce(db, rng);
    const accountId = await seedAccount(db, rng, params.email);
    const issued = await issueEntitlement({
        db,
        rng,
        catalog: harness.catalog,
        caller: await steppedUp(db, rootId),
        operationId: newOperationId(rng),
        targetAccountId: accountId,
        validFrom: EpochMs.parse(0),
        validUntil: null,
        products: [
            {
                productId: ProductId.parse("cs2"),
                features:
                    params.features === undefined
                        ? "*"
                        : params.features.map((tag) => FeatureTag.parse(tag)),
                channels: params.channels.map((channel) => ChannelId.parse(channel)),
            },
        ],
    });
    invariant(issued.ok, `issuing the entitlement failed: ${JSON.stringify(issued)}`);
    const deps = await createTestAuthDeps(db, rng);
    return { accountId, browserSession: await memberSession(deps, accountId) };
}

export const FEATURES = [
    { key: 0x1111n, tag: "aim" },
    { key: 0x2222n, tag: "esp" },
] as const;

export type PublishedRelease = { readonly id: Uint8Array; readonly seal: Uint8Array };

// Inserted directly: `ops publish-release` and the seal's format come later.
export async function publishRelease(
    db: Db,
    rng: SeededRng,
    params: {
        readonly product: string;
        readonly channel: Channel;
        readonly container?: Uint8Array;
    },
): Promise<PublishedRelease> {
    const id = rng.fillBytes(new Uint8Array(16));
    const seal = rng.fillBytes(new Uint8Array(96));
    const isModule = params.product !== "lucent-loader";
    const manifest = isModule
        ? toReleaseManifestV2Bytes({
              product: params.product,
              facts: [],
              capabilities: [],
              features: [...FEATURES],
          })
        : null;
    const container = isModule ? (params.container ?? rng.fillBytes(new Uint8Array(1_000))) : null;
    const inserted = await execute(
        db,
        sql`insert into release (id, product_id, channel, seal, container, manifest)
            values (${id}, ${params.product}, ${params.channel}, ${seal}, ${container}, ${manifest})`,
    );
    invariant(inserted.ok, `inserting the release failed: ${JSON.stringify(inserted)}`);
    const promoted = await execute(
        db,
        sql`insert into current_release (product_id, channel, release_id)
            values (${params.product}, ${params.channel}, ${id})
            on conflict (product_id, channel) do update set release_id = excluded.release_id`,
    );
    invariant(promoted.ok, "promoting the release failed");
    return { id, seal };
}

export type Releases = { readonly loader: PublishedRelease; readonly module: PublishedRelease };

export async function publishBoth(
    db: Db,
    rng: SeededRng,
    channel: Channel = "alpha",
): Promise<Releases> {
    return {
        loader: await publishRelease(db, rng, { product: "lucent-loader", channel }),
        module: await publishRelease(db, rng, { product: "cs2", channel }),
    };
}

export function startBody(params: {
    readonly loaderRelease: Uint8Array;
    readonly channel?: Channel;
    readonly product?: string;
}): Uint8Array {
    return toStartRequestBytes({
        product: params.product ?? "cs2",
        channel: params.channel ?? "alpha",
        loaderRelease: params.loaderRelease,
        modules: [{ nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 }],
    });
}

export type StartedTest = {
    readonly start: Uint8Array;
    readonly containerKey: Uint8Array;
    readonly path: string;
};

export async function startOk(loader: TestLoader, releases: Releases): Promise<StartedTest> {
    const sent = await loader.send({
        method: "POST",
        path: "/v1/starts",
        body: startBody({ loaderRelease: releases.loader.id }),
    });
    const reply = parseStartReply(sent.bytes);
    invariant(reply.ok, `starting failed: ${refusalCodeOf(sent)}`);
    return {
        start: reply.value.start,
        containerKey: reply.value.containerKey,
        path: `/v1/starts/${toHex(reply.value.start)}`,
    };
}

// The container as the loader decrypts it: chunk by chunk, each against its index and whether
// the stream ended right after it.
export function decryptContainer(key: Uint8Array, stream: Uint8Array): Uint8Array | null {
    const sealedChunk = CHUNK_NONCE_SIZE + CONTAINER_CHUNK_SIZE + CHUNK_TAG_SIZE;
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let index = 0; offset < stream.byteLength; index += 1) {
        const end = Math.min(offset + sealedChunk, stream.byteLength);
        const last = end === stream.byteLength;
        const nonce = stream.subarray(offset, offset + CHUNK_NONCE_SIZE);
        const cipher = xchacha20poly1305(
            key,
            nonce,
            toChunkAssociatedData(index, last ? "last" : "inner"),
        );
        const sealed = stream.subarray(offset + CHUNK_NONCE_SIZE, end);
        const opened = trySync(
            () => cipher.decrypt(sealed),
            () => null,
        );
        if (!opened.ok) return null;
        parts.push(opened.value);
        offset = end;
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

// The module's side: its key exchange, the leases it holds and the renewals it asks with.
export type TestModule = {
    readonly hello: (release: Uint8Array) => Promise<Uint8Array>;
    // Verifies the reply as the module does and holds its first lease.
    readonly acceptSession: (reply: Uint8Array) => Promise<Lease>;
    readonly renewal: (params?: { readonly loaderAnswer?: Uint8Array | null }) => Uint8Array;
    readonly acceptLease: (reply: Uint8Array) => Promise<Lease>;
    readonly session: () => Uint8Array;
    readonly held: () => Lease;
};

export function createTestModule(rng: SeededRng, leaseKey: Uint8Array): TestModule {
    const seed = rng.fillBytes(new Uint8Array(32));
    let moduleKey: Uint8Array = new Uint8Array(0);
    let nonce: Uint8Array = new Uint8Array(0);
    let keys: SessionKeys | null = null;
    let session: Uint8Array = new Uint8Array(0);
    let lease: Lease | null = null;
    let sentFrames = 0n;
    let receivedFrames = 0n;

    const openLease = async (frame: Parameters<typeof openFrame>[1]): Promise<Lease> => {
        invariant(keys !== null, "the session is open");
        invariant(frame.header.sequence > receivedFrames, "frames only move forward");
        receivedFrames = frame.header.sequence;
        const plain = openFrame(keys.serverToModule, frame);
        invariant(plain.ok, "the lease frame opens under the session key");
        const parsed = parseLease(plain.value);
        invariant(parsed.ok, "the lease parses");
        const { signature, ...fields } = parsed.value;
        invariant(
            await isStrictlySignedBy(leaseKey, toLeaseSignedBytes(fields), signature),
            "the lease is signed by the lease key",
        );
        invariant(toHex(parsed.value.nonce) === toHex(nonce), "the lease answers our nonce");
        lease = parsed.value;
        return parsed.value;
    };

    return {
        hello: async (release) => {
            moduleKey = await exchangePublicKey(seed);
            nonce = rng.fillBytes(new Uint8Array(16));
            return toSessionHelloBytes({
                moduleKey,
                nonce,
                release,
                boot: {
                    bootInfoVersion: 3,
                    imageKind: "mapped",
                    imageBase: 0x7ff6_0000_0000n,
                    imageSize: 0x0020_0000,
                },
            });
        },
        acceptSession: async (reply) => {
            const parsed = parseSessionReply(reply);
            invariant(parsed.ok, "the session reply parses");
            const { exchange } = parsed.value;
            invariant(
                await isStrictlySignedBy(
                    leaseKey,
                    toExchangeSignedBytes(exchange),
                    exchange.signature,
                ),
                "the exchange is signed by the lease key",
            );
            invariant(toHex(exchange.moduleKey) === toHex(moduleKey), "the exchange binds our key");
            const shared = await sharedSecret(seed, exchange.serverKey);
            invariant(shared.ok, "the server's key is a valid X25519 key");
            keys = deriveSessionKeys({
                shared: shared.value,
                moduleKey,
                serverKey: exchange.serverKey,
            });
            session = exchange.session;
            return await openLease(parsed.value.firstLease);
        },
        renewal: (params) => {
            invariant(keys !== null && lease !== null, "a lease is held");
            nonce = rng.fillBytes(new Uint8Array(16));
            sentFrames += 1n;
            const frame = sealFrame(keys.moduleToServer, {
                header: { session, direction: "module_to_server", sequence: sentFrames },
                nonce: rng.fillBytes(new Uint8Array(24)),
                plain: toLeaseRenewalBytes({
                    sequence: lease.sequence + 1n,
                    nonce,
                    challengeAnswer: new Uint8Array(CHALLENGE_ANSWER_SIZE).fill(0xa5),
                    signals: new Uint8Array(SIGNALS_SIZE).fill(0x01),
                }),
            });
            return toLeaseRequestBytes({
                loaderAnswer: params?.loaderAnswer ?? null,
                renewal: frame,
            });
        },
        acceptLease: async (reply) => {
            const parsed = parseLeaseResponse(reply);
            invariant(parsed.ok, "the lease response parses");
            return await openLease(parsed.value.lease);
        },
        session: () => session,
        held: () => {
            invariant(lease !== null, "a lease is held");
            return lease;
        },
    };
}

export function sessionPath(session: Uint8Array): string {
    return `/v1/sessions/${toHex(session)}`;
}
