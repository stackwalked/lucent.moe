import { expect, test } from "bun:test";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { parseDataResponse, toDataResponseBytes } from "@lucent/wire/data";
import { openFrame, parseFrame, toFrameBytes } from "@lucent/wire/frame";
import { type Overrides, toOverridesBytes, toOverridesSignedBytes } from "@lucent/wire/overrides";
import { signingPublicKey, signWithSeed } from "@lucent/wire/session-crypto";
import { z } from "zod";
import { type Db, queryOne, sql } from "../src/db/pool.ts";
import { readFactDelivery } from "../src/facts/publishing.ts";
import { assembleData, dataFormatOf, sealData } from "../src/runtime/data.ts";
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
    publishBoth,
    type Releases,
    refusalCodeOf,
    sessionPath,
    signIn,
    startOk,
    type TestLoader,
    type TestModule,
} from "./native-fixtures.ts";

// Data response v3 as the server builds it, taken by the simulated module. No release is answered
// in v3 yet (dataFormatOf), and nothing signs a stored document yet, so these drive assembleData
// with documents signed here under a test override key, sealed under the session's own data key.

const GAME: ModuleKey = { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 };
const OVERRIDE_SEED = new Uint8Array(32).fill(0x0d);
const ESP = FEATURES[1].key;

type Running = { readonly loader: TestLoader; readonly module: TestModule; readonly path: string };

async function run(harness: NativeHarness, releases: Releases, email: string): Promise<Running> {
    const member = await entitledMember(harness, { email, channels: ["alpha"] });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    const started = await startOk(loader, releases, [GAME]);
    const module = createTestModule(
        harness.rng,
        harness.signer.publicKey,
        await signingPublicKey(OVERRIDE_SEED),
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
        readonly overrides: Uint8Array | null;
    },
): Promise<Uint8Array> {
    const session = params.running.module.session();
    const row = await queryOne(
        db,
        z.object({ key: z.instanceof(Uint8Array), revision: z.coerce.bigint() }),
        sql`select data_key_to_module as key, data_revision as revision
            from runtime_session where id = ${session}`,
    );
    invariant(row.ok && row.value !== null, "the session's data key is stored");
    const delivery = await readFactDelivery(db, { releaseId: params.releaseId, builds: [GAME] });
    invariant(delivery.ok, "reading the delivery failed");
    const plain = assembleData({
        answers: params.sequence,
        dataRevision: row.value.revision,
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

test("the module takes a v3 response's signed document for its release, and refuses an older revision replayed after it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_951);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, "v3@lucent.test");
        const base = { release: releases.module.id, product: "cs2", capabilities: [] };
        const off = await signedDocument(OVERRIDE_SEED, { ...base, revision: 1n, features: [ESP] });
        const on = await signedDocument(OVERRIDE_SEED, { ...base, revision: 2n, features: [] });
        const frame = (sequence: bigint, overrides: Uint8Array | null) =>
            v3Frame(nativeDb, { running, releaseId: releases.module.id, sequence, overrides });
        const take = async (sequence: bigint, overrides: Uint8Array | null) =>
            (await running.module.acceptDataV3(await frame(sequence, overrides))).overrides;

        const none = await running.module.acceptDataV3(await frame(1n, null));
        expect(none.overrides).toBe("none");
        expect(none.response.overrides).toBeNull();
        expect(none.response.answers).toBe(1n);

        expect(await take(2n, off)).toBe("taken");
        expect(running.module.overrides()?.features).toEqual([ESP]);
        // The same document again, as every response until the next switch carries it.
        expect(await take(3n, off)).toBe("taken");
        expect(await take(4n, on)).toBe("taken");
        expect(running.module.overrides()?.features).toEqual([]);

        expect(await take(5n, off)).toBe("older_revision");
        expect(running.module.overrides()?.revision).toBe(2n);
    });
});

test("the module refuses a v3 document another key signed or another release's", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_952);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, "forged@lucent.test");
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

test("every release is still answered in data response v2, byte for byte as the v2 encoder writes it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_953);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, "v2@lucent.test");

        expect(dataFormatOf(releases.module.id)).toEqual({ version: 2 });
        const sent = await running.loader.send({
            method: "POST",
            path: `${running.path}/data`,
            body: running.module.dataRequest([GAME]),
        });
        expect(sent.status).toBe(200);
        const keys = await queryOne(
            nativeDb,
            z.object({ key: z.instanceof(Uint8Array) }),
            sql`select data_key_to_module as key from runtime_session
                where id = ${running.module.session()}`,
        );
        invariant(keys.ok && keys.value !== null, "the session's data key is stored");
        const frame = parseFrame(sent.bytes);
        invariant(frame.ok, "the reply is a frame");
        const plain = openFrame(keys.value.key, frame.value);
        invariant(plain.ok, "the frame opens under the data key");
        const response = parseDataResponse(plain.value);
        invariant(response.ok, "the reply is a data response v2");
        expect(plain.value).toEqual(toDataResponseBytes(response.value));
        expect(running.module.firstData().answers).toBe(0n);
    });
});
