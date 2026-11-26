import { join } from "node:path";
import { blake2b256 } from "@lucent/bundle/crypto";
import {
    type DataResponseVersion,
    type ReleaseManifestV3,
    toReleaseManifestV3Bytes,
    toReleaseManifestV4Bytes,
} from "@lucent/bundle/release-manifest";
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
import {
    type CloudRequest,
    type CloudResponse,
    parseCloudResponse,
    toCloudRequestBytes,
} from "@lucent/wire/cloud";
import {
    CHUNK_NONCE_SIZE,
    CHUNK_TAG_SIZE,
    CONTAINER_CHUNK_SIZE,
    toChunkAssociatedData,
} from "@lucent/wire/container-stream";
import {
    type DataResponse,
    type DataResponseV3,
    parseDataResponse,
    parseDataResponseV3,
    toDataRequestBytes,
} from "@lucent/wire/data";
import { parseEnrollmentStatus, toEnrollmentRequestBytes } from "@lucent/wire/enrollment";
import { openFrame, parseFrame, sealFrame, toFrameBytes } from "@lucent/wire/frame";
import {
    CHALLENGE_ANSWER_SIZE,
    type Lease,
    parseLease,
    SIGNALS_SIZE,
    toLeaseRenewalBytes,
    toLeaseSignedBytes,
} from "@lucent/wire/lease";
import { parseLeaseResponse, toLeaseRequestBytes } from "@lucent/wire/lease-exchange";
import { type Overrides, parseOverrides, toOverridesSignedBytes } from "@lucent/wire/overrides";
import { parseRefusal, type RefusalCode } from "@lucent/wire/refusal";
import { toReleaseSealBytes } from "@lucent/wire/release-seal";
import {
    parseReportsAck,
    type ReportEvent,
    type ReportsAck,
    toReportsRequestBytes,
} from "@lucent/wire/reports";
import {
    deriveSessionKeys,
    parseSessionReply,
    type SessionKeys,
    toExchangeSignedBytes,
    toSessionHelloBytes,
} from "@lucent/wire/session";
import { exchangePublicKey, sharedSecret } from "@lucent/wire/session-crypto";
import {
    type Channel,
    parseStartReply,
    type StartRequest,
    toStartRequestBytes,
} from "@lucent/wire/start";
import { isStrictlySignedBy } from "@lucent/wire/strict-signature";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { calculateJwkThumbprint, SignJWT } from "jose";
import { z } from "zod";
import { type Db, execute, sql } from "../src/base/db/pool.ts";
import { CLOUD_LIMITS, type CloudLimits } from "../src/delivery/cloud/items.rules.ts";
import { createLeaseSigner, type LeaseSigner } from "../src/delivery/runtime/lease-key.ts";
import { createNativeApp } from "../src/edge/listeners/native/app.ts";
import type { RateRule } from "../src/edge/listeners/native/rate-limit.ts";
import { DEFAULT_RATE_LIMITS } from "../src/edge/listeners/native/route-context.ts";
import { issueEntitlement } from "../src/identity/authority/writers.ts";
import { approveEnrollment } from "../src/identity/devices/devices.ts";
import { answerSignInRequest, SignInRequestId } from "../src/identity/devices/sign-in.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, seedAccount, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";

export const ORIGIN = "https://api.lucent.test";
// A fixed lease key: tests check signatures against its public half, as a module would.
export const LEASE_SEED = new Uint8Array(32).fill(7);
// A fixed override key: the simulated module checks documents against its public half.
export const OVERRIDE_SEED = new Uint8Array(32).fill(0x0d);

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
    options?: {
        readonly clock?: Clock;
        readonly rateLimits?: Readonly<Record<string, RateRule>>;
        readonly artifactDir?: string;
        readonly catalog?: ProductCatalog;
        // The site's defaults unless given; null runs without them.
        readonly cloudLimits?: CloudLimits | null;
    },
): Promise<NativeHarness> {
    const cloudLimits = options?.cloudLimits === undefined ? CLOUD_LIMITS : options.cloudLimits;
    const products = options?.catalog ?? catalog();
    const signer = await createLeaseSigner(LEASE_SEED);
    const app = createNativeApp({
        db,
        rng,
        clock: options?.clock ?? systemClock,
        catalog: products,
        signer,
        origin: ORIGIN,
        artifactDir: options?.artifactDir ?? "unused-artifact-dir",
        isSuperseded: () => false,
        logger: { write: () => {} },
        rateLimits: options?.rateLimits ?? DEFAULT_RATE_LIMITS,
        ...(cloudLimits === null ? {} : { cloudLimits }),
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
    const decided = await answerSignInRequest(harness.db, {
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

// Inserted directly and promoted at once, with a random seal and container: what the start and
// session tests need. native-publish.test.ts goes through publishing with real ones.
export async function publishRelease(
    db: Db,
    rng: SeededRng,
    params: {
        readonly product: string;
        readonly channel: Channel;
        readonly container?: Uint8Array;
        readonly facts?: ReleaseManifestV3["facts"];
        readonly capabilities?: ReleaseManifestV3["capabilities"];
        // Given, the manifest is version 4 and says so, as publishing stores it; left out, it is
        // version 3, whose module reads data response version 2.
        readonly dataResponse?: DataResponseVersion;
    },
): Promise<PublishedRelease> {
    const id = rng.fillBytes(new Uint8Array(16));
    const seal = rng.fillBytes(new Uint8Array(96));
    const isModule = params.product !== "lucent-loader";
    const fields = {
        product: params.product,
        facts: params.facts ?? [],
        capabilities: params.capabilities ?? [],
        features: [...FEATURES],
    };
    const manifest = !isModule
        ? null
        : params.dataResponse === undefined
          ? toReleaseManifestV3Bytes(fields)
          : toReleaseManifestV4Bytes({ ...fields, dataResponse: params.dataResponse });
    const container = isModule ? (params.container ?? rng.fillBytes(new Uint8Array(1_000))) : null;
    const inserted = await execute(
        db,
        sql`insert into release (id, product_id, channel, container, manifest, data_response)
            values (${id}, ${params.product}, ${params.channel}, ${container}, ${manifest},
                    ${params.dataResponse ?? 2})`,
    );
    invariant(inserted.ok, `inserting the release failed: ${JSON.stringify(inserted)}`);
    const sealed = await execute(
        db,
        sql`insert into release_seal (product_id, channel, number, release_id, seal)
            select ${params.product}, ${params.channel}, coalesce(max(number), 0) + 1, ${id}, ${seal}
            from release_seal where product_id = ${params.product} and channel = ${params.channel}`,
    );
    invariant(sealed.ok, `inserting the seal failed: ${JSON.stringify(sealed)}`);
    const promoted = await execute(
        db,
        sql`insert into current_release (product_id, channel, number)
            select product_id, channel, max(number) from release_seal
            where product_id = ${params.product} and channel = ${params.channel}
            group by product_id, channel
            on conflict (product_id, channel) do update set number = excluded.number`,
    );
    invariant(promoted.ok, "promoting the release failed");
    return { id, seal };
}

export type PromotedLoader = {
    readonly seal: Uint8Array;
    readonly loader: Uint8Array;
    readonly host: Uint8Array;
};

// A loader release with a parseable seal (its signature isn't checked here; publishing does
// that), its two artifacts written under `artifactDir` by digest, promoted at once.
export async function promoteLoader(
    db: Db,
    rng: SeededRng,
    params: { readonly number: bigint; readonly artifactDir: string },
): Promise<PromotedLoader> {
    const loader = rng.fillBytes(new Uint8Array(3_000));
    const host = rng.fillBytes(new Uint8Array(2_000));
    for (const bytes of [loader, host]) {
        await Bun.write(join(params.artifactDir, blake2b256(bytes).toHex()), bytes);
    }
    const release = rng.fillBytes(new Uint8Array(16));
    const seal = toReleaseSealBytes({
        product: "lucent-loader",
        channel: "stable",
        number: params.number,
        release,
        bootInfoVersion: 1,
        artifacts: [
            { kind: "loader", digest: blake2b256(loader) },
            { kind: "host", digest: blake2b256(host) },
        ],
        signature: new Uint8Array(64),
    });
    const stored = await execute(
        db,
        sql`insert into release (id, product_id, channel, container, manifest)
            values (${release}, 'lucent-loader', 'stable', null, null)`,
    );
    invariant(stored.ok, "inserting the release failed");
    const sealed = await execute(
        db,
        sql`insert into release_seal (product_id, channel, number, release_id, seal)
            values ('lucent-loader', 'stable', ${params.number}, ${release}, ${seal})`,
    );
    invariant(sealed.ok, "inserting the seal failed");
    const promoted = await execute(
        db,
        sql`insert into current_release (product_id, channel, number)
            values ('lucent-loader', 'stable', ${params.number})
            on conflict (product_id, channel) do update set number = excluded.number`,
    );
    invariant(promoted.ok, "promoting the release failed");
    return { seal, loader, host };
}

export type Releases = { readonly loader: PublishedRelease; readonly module: PublishedRelease };

export async function publishBoth(
    db: Db,
    rng: SeededRng,
    channel: Channel = "alpha",
): Promise<Releases> {
    return {
        loader: await publishRelease(db, rng, { product: "lucent-loader", channel: "stable" }),
        module: await publishRelease(db, rng, { product: "cs2", channel }),
    };
}

export function startBody(params: {
    readonly loaderRelease: Uint8Array;
    readonly channel?: Channel;
    readonly product?: string;
    readonly modules?: StartRequest["modules"];
}): Uint8Array {
    return toStartRequestBytes({
        product: params.product ?? "cs2",
        channel: params.channel ?? "alpha",
        loaderRelease: params.loaderRelease,
        modules: params.modules ?? [
            { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 },
        ],
    });
}

export type StartedTest = {
    readonly start: Uint8Array;
    readonly containerKey: Uint8Array;
    readonly path: string;
};

export async function startOk(
    loader: TestLoader,
    releases: Releases,
    modules?: StartRequest["modules"],
): Promise<StartedTest> {
    const sent = await loader.send({
        method: "POST",
        path: "/v1/starts",
        body: startBody({
            loaderRelease: releases.loader.id,
            ...(modules === undefined ? {} : { modules }),
        }),
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
    // The renewal's integrity field is all zeros (a clean machine) unless `signals` is given.
    readonly renewal: (params?: {
        readonly loaderAnswer?: Uint8Array | null;
        readonly signals?: Uint8Array;
    }) => Uint8Array;
    readonly acceptLease: (reply: Uint8Array) => Promise<Lease>;
    // The data_response the session reply carried, opened under the data route's key.
    readonly firstData: () => DataResponse;
    // A data_request frame for these builds, as the body of POST /v1/sessions/:id/data; each call
    // takes the next sequence unless one is given.
    readonly dataRequest: (
        modules: StartRequest["modules"],
        params?: { readonly sequence?: bigint },
    ) => Uint8Array;
    readonly acceptData: (reply: Uint8Array) => DataResponse;
    // A data response v3 frame: the response, and what became of its override document. The
    // module takes a document only when the override key signed it for its own release at a
    // revision at or above the highest it has taken; otherwise it keeps the one it holds.
    readonly acceptDataV3: (frame: Uint8Array) => Promise<{
        readonly response: DataResponseV3;
        readonly overrides: OverridesTaken;
    }>;
    // What became of the document the session reply's first response carried (version 3 only).
    readonly firstOverrides: () => OverridesTaken;
    // The document the module holds: the newest it took.
    readonly overrides: () => Overrides | null;
    // A cloud_request frame, sealed under the data keys on the data route's sequences, as
    // dataRequest is.
    readonly cloudRequest: (
        request: CloudRequest,
        params?: { readonly sequence?: bigint },
    ) => Uint8Array;
    readonly acceptCloud: (reply: Uint8Array) => CloudResponse;
    // A reports batch, sealed under the reports route's keys on its own sequences: each call
    // takes the next unless one is given.
    readonly reports: (
        events: readonly ReportEvent[],
        params?: { readonly sequence?: bigint },
    ) => Uint8Array;
    // The ack and the sequence of the frame that carried it.
    readonly acceptReports: (reply: Uint8Array) => {
        readonly sequence: bigint;
        readonly ack: ReportsAck;
    };
    readonly session: () => Uint8Array;
    readonly held: () => Lease;
};

export type OverridesTaken =
    | "none"
    | "taken"
    | "malformed"
    | "unsigned"
    | "other_release"
    | "older_revision";

// A module build that reads data response version 3 carries the override key's public half, and
// reads version 3 from its first response on; one given null reads version 2.
export function createTestModule(
    rng: SeededRng,
    leaseKey: Uint8Array,
    overrideKey: Uint8Array | null = null,
): TestModule {
    const seed = rng.fillBytes(new Uint8Array(32));
    let release: Uint8Array = new Uint8Array(0);
    let overrides: Overrides | null = null;
    let moduleKey: Uint8Array = new Uint8Array(0);
    let nonce: Uint8Array = new Uint8Array(0);
    let keys: SessionKeys | null = null;
    let session: Uint8Array = new Uint8Array(0);
    let lease: Lease | null = null;
    let sentFrames = 0n;
    let receivedFrames = 0n;
    let sentData = 0n;
    let sentReports = 0n;
    let firstData: DataResponse | null = null;
    let firstOverrides: OverridesTaken | null = null;

    const openData = (frame: Parameters<typeof openFrame>[1]): DataResponse => {
        invariant(keys !== null, "the session is open");
        const plain = openFrame(keys.data.serverToModule, frame);
        invariant(plain.ok, "the data frame opens under the data route's key");
        const parsed = parseDataResponse(plain.value);
        invariant(parsed.ok, "the data response parses");
        return parsed.value;
    };

    const openDataV3 = (frame: Parameters<typeof openFrame>[1]): DataResponseV3 => {
        invariant(keys !== null, "the session is open");
        const plain = openFrame(keys.data.serverToModule, frame);
        invariant(plain.ok, "the data frame opens under the data route's key");
        const parsed = parseDataResponseV3(plain.value);
        invariant(parsed.ok, "the data response v3 parses");
        return parsed.value;
    };

    const sealData = (plain: Uint8Array, sequence: bigint | undefined): Uint8Array => {
        invariant(keys !== null, "the session is open");
        sentData += 1n;
        const frame = sealFrame(keys.data.moduleToServer, {
            header: { session, direction: "module_to_server", sequence: sequence ?? sentData },
            nonce: rng.fillBytes(new Uint8Array(24)),
            plain,
        });
        return toFrameBytes(frame);
    };

    const openLease = async (frame: Parameters<typeof openFrame>[1]): Promise<Lease> => {
        invariant(keys !== null, "the session is open");
        invariant(frame.header.sequence > receivedFrames, "frames only move forward");
        receivedFrames = frame.header.sequence;
        const plain = openFrame(keys.lease.serverToModule, frame);
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

    const takeOverrides = async (document: Uint8Array | null): Promise<OverridesTaken> => {
        if (document === null) return "none";
        const parsed = parseOverrides(document);
        if (!parsed.ok) return "malformed";
        const { signature, ...fields } = parsed.value;
        const signed =
            overrideKey !== null &&
            (await isStrictlySignedBy(overrideKey, toOverridesSignedBytes(fields), signature));
        if (!signed) return "unsigned";
        if (toHex(fields.release) !== toHex(release)) return "other_release";
        if (overrides !== null && fields.revision < overrides.revision) return "older_revision";
        overrides = parsed.value;
        return "taken";
    };

    return {
        hello: async (helloRelease) => {
            release = helloRelease;
            moduleKey = await exchangePublicKey(seed);
            nonce = rng.fillBytes(new Uint8Array(16));
            return toSessionHelloBytes({
                moduleKey,
                nonce,
                release: helloRelease,
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
            invariant(parsed.value.firstData.header.sequence === 0n, "the first data frame is 0");
            if (overrideKey === null) {
                firstData = openData(parsed.value.firstData);
            } else {
                const opened = openDataV3(parsed.value.firstData);
                firstData = opened;
                firstOverrides = await takeOverrides(opened.overrides);
            }
            return await openLease(parsed.value.firstLease);
        },
        renewal: (params) => {
            invariant(keys !== null && lease !== null, "a lease is held");
            nonce = rng.fillBytes(new Uint8Array(16));
            sentFrames += 1n;
            const frame = sealFrame(keys.lease.moduleToServer, {
                header: { session, direction: "module_to_server", sequence: sentFrames },
                nonce: rng.fillBytes(new Uint8Array(24)),
                plain: toLeaseRenewalBytes({
                    sequence: lease.sequence + 1n,
                    nonce,
                    challengeAnswer: new Uint8Array(CHALLENGE_ANSWER_SIZE).fill(0xa5),
                    signals: params?.signals ?? new Uint8Array(SIGNALS_SIZE),
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
        firstData: () => {
            invariant(firstData !== null, "a session reply was accepted");
            return firstData;
        },
        dataRequest: (modules, params) =>
            sealData(toDataRequestBytes({ modules, features: null }), params?.sequence),
        acceptData: (reply) => {
            const frame = parseFrame(reply);
            invariant(frame.ok, "the data reply is a frame");
            return openData(frame.value);
        },
        acceptDataV3: async (reply) => {
            const frame = parseFrame(reply);
            invariant(frame.ok, "the data reply is a frame");
            const response = openDataV3(frame.value);
            return { response, overrides: await takeOverrides(response.overrides) };
        },
        firstOverrides: () => {
            invariant(firstOverrides !== null, "a version 3 session reply was accepted");
            return firstOverrides;
        },
        overrides: () => overrides,
        cloudRequest: (request, params) => sealData(toCloudRequestBytes(request), params?.sequence),
        acceptCloud: (reply) => {
            const frame = parseFrame(reply);
            invariant(frame.ok && keys !== null, "the cloud reply is a frame of an open session");
            const plain = openFrame(keys.data.serverToModule, frame.value);
            invariant(plain.ok, "the cloud frame opens under the data route's key");
            const parsed = parseCloudResponse(plain.value);
            invariant(parsed.ok, "the cloud response parses");
            return parsed.value;
        },
        reports: (events, params) => {
            invariant(keys !== null, "the session is open");
            sentReports += 1n;
            const frame = sealFrame(keys.reports.moduleToServer, {
                header: {
                    session,
                    direction: "module_to_server",
                    sequence: params?.sequence ?? sentReports,
                },
                nonce: rng.fillBytes(new Uint8Array(24)),
                plain: toReportsRequestBytes({ events }),
            });
            return toFrameBytes(frame);
        },
        acceptReports: (reply) => {
            const frame = parseFrame(reply);
            invariant(frame.ok && keys !== null, "the reports reply is a frame of an open session");
            invariant(frame.value.header.direction === "server_to_module", "the server's frame");
            const plain = openFrame(keys.reports.serverToModule, frame.value);
            invariant(plain.ok, "the ack opens under the reports route's key");
            const parsed = parseReportsAck(plain.value);
            invariant(parsed.ok, "the ack parses");
            return { sequence: frame.value.header.sequence, ack: parsed.value };
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
