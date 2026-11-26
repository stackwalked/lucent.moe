import { expect, test } from "bun:test";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type BearerToken, toHex } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { parseDataResponse, toDataResponseBytes } from "@lucent/wire/data";
import { openFrame, parseFrame, toFrameBytes } from "@lucent/wire/frame";
import {
    type Overrides,
    parseOverrides,
    toOverridesBytes,
    toOverridesSignedBytes,
} from "@lucent/wire/overrides";
import { signingPublicKey, signWithSeed } from "@lucent/wire/session-crypto";
import { z } from "zod";
import { type Db, execute, queryOne, sql } from "../src/base/db/pool.ts";
import { readFactDelivery } from "../src/delivery/facts/publishing.ts";
import { assembleData, readDataFormat, sealData } from "../src/delivery/runtime/data.ts";
import { createOverrideSigner } from "../src/delivery/runtime/lease-key.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import { hashToken } from "../src/identity/auth/tokens.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { catalog } from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    enroll,
    entitledMember,
    FEATURES,
    type NativeHarness,
    OVERRIDE_SEED,
    type PublishedRelease,
    publishRelease,
    refusalCodeOf,
    sessionPath,
    signIn,
    startOk,
    type TestLoader,
    type TestModule,
} from "./native-fixtures.ts";

// Kill switches reaching a module: the admin procedure signs the release's override document,
// data response version 3 carries it to a release whose manifest says its module reads it, and
// the simulated module takes it under the override key's public half.

const GAME: ModuleKey = { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 };
const ESP = FEATURES[1].key;
const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

type Running = { readonly loader: TestLoader; readonly module: TestModule; readonly path: string };

async function publishPair(harness: NativeHarness, dataResponse: 2 | 3 | null) {
    return {
        loader: await publishRelease(harness.db, harness.rng, {
            product: "lucent-loader",
            channel: "stable",
        }),
        module: await publishRelease(harness.db, harness.rng, {
            product: "cs2",
            channel: "alpha",
            ...(dataResponse === null ? {} : { dataResponse }),
        }),
    };
}

async function run(
    harness: NativeHarness,
    releases: { readonly loader: PublishedRelease; readonly module: PublishedRelease },
    params: { readonly email: string; readonly readsV3: boolean },
): Promise<Running> {
    const member = await entitledMember(harness, { email: params.email, channels: ["alpha"] });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    const started = await startOk(loader, releases, [GAME]);
    const module = createTestModule(
        harness.rng,
        harness.signer.publicKey,
        params.readsV3 ? await signingPublicKey(OVERRIDE_SEED) : null,
    );
    const opened = await loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { loader, module, path: sessionPath(module.session()) };
}

async function renew(running: Running) {
    const sent = await running.loader.send({
        method: "POST",
        path: `${running.path}/lease`,
        body: running.module.renewal(),
    });
    invariant(sent.status === 200, `the renewal was refused: ${refusalCodeOf(sent)}`);
    return await running.module.acceptLease(sent.bytes);
}

async function askData(running: Running): Promise<Uint8Array> {
    const sent = await running.loader.send({
        method: "POST",
        path: `${running.path}/data`,
        body: running.module.dataRequest([GAME]),
    });
    invariant(sent.status === 200, `the data request was refused: ${refusalCodeOf(sent)}`);
    return sent.bytes;
}

// admin.overrides.set as web calls it, for a stepped-up root holding a member session.
async function adminClient(harness: NativeHarness) {
    const auth = await createTestAuthDeps(harness.db, harness.rng);
    const root: BearerToken = await memberSession(
        auth,
        await seedRootOnce(harness.db, harness.rng),
    );
    const stepped = await execute(
        harness.db,
        sql`update browser_session set step_up_at = now() where token_hash = ${await hashToken(root)}`,
    );
    invariant(stepped.ok, "stepping up failed");
    const overrideSigner = await createOverrideSigner(OVERRIDE_SEED);
    const app = mountInternalRpc({
        path: "/rpc",
        peerKey: PEER_KEY,
        procedures: webProcedures,
        createContext: () =>
            Promise.resolve(ok({ catalog: catalog(), auth, logger: NO_LOG, overrideSigner })),
        onUnhandledError: () => {},
    });
    const client = createRpcClient(webContract, {
        endpointUrl: "http://localhost/rpc",
        peerKey: PEER_KEY,
        fetcher: async (req) => await app.fetch(req),
    });
    return async (release: Uint8Array, esp: "off" | "on") => {
        const set = await client.call(
            "admin.overrides.set",
            {
                releaseId: toHex(release),
                kind: "feature",
                key: ESP.toString(16).padStart(16, "0"),
                off: esp === "off",
            },
            { session: root },
        );
        invariant(set.ok, `switching failed: ${JSON.stringify(set)}`);
        return set.value;
    };
}

test("a kill switch set in admin reaches a running v4-manifest session at its next data request after the lease says the revision changed", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_951));
        const releases = await publishPair(harness, 3);
        const running = await run(harness, releases, { email: "v4@lucent.test", readsV3: true });
        const setEsp = await adminClient(harness);

        // The first response, in the session reply, already reads version 3: nothing switched yet.
        expect(running.module.firstOverrides()).toBe("none");
        expect((await renew(running)).dataRevision).toBe(0n);

        expect(await setEsp(releases.module.id, "off")).toEqual({ changed: true, revision: 1 });
        expect((await renew(running)).dataRevision).toBe(1n);
        const offFrame = await askData(running);
        const off = await running.module.acceptDataV3(offFrame);
        expect(off.response.dataRevision).toBe(1n);
        expect(off.overrides).toBe("taken");
        expect(running.module.overrides()).toMatchObject({
            revision: 1n,
            product: "cs2",
            features: [ESP],
            capabilities: [],
        });

        // Back on: an empty document at the next revision.
        expect(await setEsp(releases.module.id, "on")).toEqual({ changed: true, revision: 2 });
        expect((await renew(running)).dataRevision).toBe(2n);
        expect((await running.module.acceptDataV3(await askData(running))).overrides).toBe("taken");
        expect(running.module.overrides()).toMatchObject({ revision: 2n, features: [] });

        // The revision-1 response replayed to the module: it keeps the newer document.
        expect((await running.module.acceptDataV3(offFrame)).overrides).toBe("older_revision");
        expect(running.module.overrides()).toMatchObject({ revision: 2n, features: [] });

        // A session opened after the switch has its document from the session reply.
        expect(await setEsp(releases.module.id, "off")).toEqual({ changed: true, revision: 3 });
        const later = await run(harness, releases, { email: "later@lucent.test", readsV3: true });
        expect(later.module.firstOverrides()).toBe("taken");
        expect(later.module.overrides()).toMatchObject({ revision: 3n, features: [ESP] });
    });
});

test("a v3-manifest release is still answered in data response v2, byte for byte, with a switch set on it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_953));
        const releases = await publishPair(harness, null);
        const running = await run(harness, releases, { email: "v2@lucent.test", readsV3: false });
        const setEsp = await adminClient(harness);

        expect(await setEsp(releases.module.id, "off")).toEqual({ changed: true, revision: 1 });
        expect(await readDataFormat(nativeDb, releases.module.id)).toEqual({
            ok: true,
            value: { version: 2 },
        });
        // The document is signed and stored all the same, for no module that reads it.
        const stored = await queryOne(
            nativeDb,
            z.object({ document: z.instanceof(Uint8Array) }),
            sql`select document from fact_override_revision where release_id = ${releases.module.id}`,
        );
        invariant(stored.ok && stored.value !== null, "the document is stored");
        expect(parseOverrides(stored.value.document).ok).toBe(true);

        expect((await renew(running)).dataRevision).toBe(1n);
        const sent = await askData(running);
        const keys = await queryOne(
            nativeDb,
            z.object({ key: z.instanceof(Uint8Array) }),
            sql`select data_key_to_module as key from runtime_session
                where id = ${running.module.session()}`,
        );
        invariant(keys.ok && keys.value !== null, "the session's data key is stored");
        const frame = parseFrame(sent);
        invariant(frame.ok, "the reply is a frame");
        const plain = openFrame(keys.value.key, frame.value);
        invariant(plain.ok, "the frame opens under the data key");
        const response = parseDataResponse(plain.value);
        invariant(response.ok, "the reply is a data response v2");
        expect(response.value.dataRevision).toBe(1n);
        expect(plain.value).toEqual(toDataResponseBytes(response.value));
    });
});

async function signedDocument(
    seed: Uint8Array,
    fields: Omit<Overrides, "signature">,
): Promise<Uint8Array> {
    const signature = await signWithSeed(seed, toOverridesSignedBytes(fields));
    return toOverridesBytes({ ...fields, signature });
}

// What serveData would seal for this session in version 3, carrying `overrides`.
async function v3Frame(
    db: Db,
    params: {
        readonly running: Running;
        readonly releaseId: Uint8Array;
        readonly sequence: bigint;
        readonly overrides: Uint8Array;
    },
): Promise<Uint8Array> {
    const session = params.running.module.session();
    const row = await queryOne(
        db,
        z.object({ key: z.instanceof(Uint8Array) }),
        sql`select data_key_to_module as key from runtime_session where id = ${session}`,
    );
    invariant(row.ok && row.value !== null, "the session's data key is stored");
    const delivery = await readFactDelivery(db, { releaseId: params.releaseId, builds: [GAME] });
    invariant(delivery.ok, "reading the delivery failed");
    const plain = assembleData({
        answers: params.sequence,
        dataRevision: 0n,
        delivery: delivery.value,
        format: { version: 3, overrides: params.overrides },
    });
    invariant(plain.ok, "the response fits a frame");
    return toFrameBytes(
        sealData({
            rng: createSeededRng(1),
            key: row.value.key,
            session,
            sequence: params.sequence,
            plain: plain.value,
        }),
    );
}

test("the module refuses a v3 document another key signed or another release's", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_952));
        const releases = await publishPair(harness, 3);
        const running = await run(harness, releases, {
            email: "forged@lucent.test",
            readsV3: true,
        });
        const fields = {
            release: releases.module.id,
            product: "cs2",
            revision: 9n,
            features: [ESP],
            capabilities: [],
        };
        const frame = (sequence: bigint, overrides: Uint8Array) =>
            v3Frame(nativeDb, { running, releaseId: releases.module.id, sequence, overrides });

        const forged = await signedDocument(new Uint8Array(32).fill(0x0e), fields);
        const elsewhere = await signedDocument(OVERRIDE_SEED, {
            ...fields,
            release: releases.loader.id,
        });
        expect((await running.module.acceptDataV3(await frame(1n, forged))).overrides).toBe(
            "unsigned",
        );
        expect((await running.module.acceptDataV3(await frame(2n, elsewhere))).overrides).toBe(
            "other_release",
        );
        expect(running.module.overrides()).toBeNull();
    });
});
