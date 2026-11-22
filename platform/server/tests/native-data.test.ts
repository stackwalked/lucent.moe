import { expect, test } from "bun:test";
import { deliverAll, parseBundle, toBundleBytes } from "@lucent/bundle/bundle";
import { type FactSetHeader, fromLiteral, type ModuleKey } from "@lucent/bundle/fact-set";
import { leafHash, treeRoot } from "@lucent/bundle/merkle";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId } from "@lucent/core/scalars";
import { parseFrame } from "@lucent/wire/frame";
import { type Db, execute, sql } from "../src/db/pool.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    enroll,
    entitledMember,
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

const GAME: ModuleKey = { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 };
const NO_FACTS: ModuleKey = { nameHash: 0x4321n, timeDateStamp: 7, sizeOfImage: 8 };
const LATE: ModuleKey = { nameHash: 0x7777n, timeDateStamp: 5, sizeOfImage: 6 };

// A current set for the builds, stored as publishing would but unsigned: delivering reads the
// stored bytes and never verifies them.
async function currentSet(
    db: Db,
    release: Uint8Array,
    modules: readonly ModuleKey[],
    keys: readonly bigint[],
): Promise<void> {
    const entries = keys.map((key) => fromLiteral(key, key + 1n));
    const unsigned: FactSetHeader = {
        game: 1,
        revision: 1,
        modules,
        findersCommit: new Uint8Array(20),
        manifestDigest: new Uint8Array(32),
        entryCount: entries.length,
        merkleRoot: treeRoot(entries.map(leafHash)),
        signature: new Uint8Array(64),
    };
    const bundle = toBundleBytes([deliverAll({ header: unsigned, entries })]);
    const factKeys = new Uint8Array(keys.length * 8);
    keys.forEach((key, index) => {
        new DataView(factKeys.buffer).setBigUint64(index * 8, key, true);
    });
    const inserted = await execute(
        db,
        sql`with s as (
                insert into fact_set (release_id, bundle, fact_keys)
                values (${release}, ${bundle}, ${factKeys}) returning id),
            b as (
                insert into fact_set_build
                    (set_id, release_id, name_hash, time_date_stamp, size_of_image, revision)
                select s.id, ${release}, m.name_hash::numeric, m.tds, m.size, 1
                from s, jsonb_to_recordset(${JSON.stringify(
                    modules.map((m) => ({
                        name_hash: m.nameHash.toString(),
                        tds: m.timeDateStamp,
                        size: m.sizeOfImage,
                    })),
                )}::jsonb) as m(name_hash text, tds bigint, size bigint))
            insert into current_fact_set
                (release_id, name_hash, time_date_stamp, size_of_image, revision)
            select ${release}, m.name_hash::numeric, m.tds, m.size, 1
            from jsonb_to_recordset(${JSON.stringify(
                modules.map((m) => ({
                    name_hash: m.nameHash.toString(),
                    tds: m.timeDateStamp,
                    size: m.sizeOfImage,
                })),
            )}::jsonb) as m(name_hash text, tds bigint, size bigint)`,
    );
    invariant(inserted.ok, `storing the set failed: ${JSON.stringify(inserted)}`);
}

type Running = { readonly loader: TestLoader; readonly module: TestModule; readonly path: string };

async function run(
    harness: NativeHarness,
    releases: Releases,
    reported: readonly ModuleKey[],
): Promise<Running> {
    const member = await entitledMember(harness, {
        email: "data@lucent.test",
        channels: ["alpha"],
        features: ["esp"],
    });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    const started = await startOk(loader, releases, reported);
    const module = createTestModule(harness.rng, harness.signer.publicKey);
    const opened = await loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { loader, module, path: sessionPath(module.session()) };
}

function setsOf(bundle: Uint8Array) {
    const parsed = parseBundle(bundle);
    invariant(parsed.ok, "the bundle parses");
    return parsed.value.map((set) => ({
        modules: set.header.modules,
        keys: set.entries.map((given) => given.entry.key),
    }));
}

function askData(running: Running, body: Uint8Array, operationId?: string) {
    return running.loader.send({
        method: "POST",
        path: `${running.path}/data`,
        body,
        ...(operationId === undefined ? {} : { operationId }),
    });
}

test("the session reply's data frame opens under the data key with the covered builds' sets and the uncovered builds unsupported", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_501);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [GAME], [0x10n, 0x20n]);
        const running = await run(harness, releases, [GAME, NO_FACTS]);

        const first = running.module.firstData();
        expect(first.dataRevision).toBe(0n);
        expect(setsOf(first.bundle)).toEqual([{ modules: [GAME], keys: [0x10n, 0x20n] }]);
        expect(first.unsupported).toEqual([NO_FACTS]);
    });
});

test("a set listing a build the session didn't report is not delivered, and its reported builds are unsupported", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_502);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [GAME, LATE], [0x10n]);
        const running = await run(harness, releases, [GAME]);

        const first = running.module.firstData();
        expect(setsOf(first.bundle)).toEqual([]);
        expect(first.unsupported).toEqual([GAME]);
    });
});

test("a data request for a late-loaded build gets that build's set", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_503);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [LATE], [0x30n]);
        const running = await run(harness, releases, [GAME]);

        const sent = await askData(running, running.module.dataRequest([LATE]));
        expect(sent.status).toBe(200);
        const answer = running.module.acceptData(sent.bytes);
        expect(setsOf(answer.bundle)).toEqual([{ modules: [LATE], keys: [0x30n] }]);
        expect(answer.unsupported).toEqual([]);

        const unknown = await askData(running, running.module.dataRequest([NO_FACTS]));
        const refused = running.module.acceptData(unknown.bytes);
        expect(setsOf(refused.bundle)).toEqual([]);
        expect(refused.unsupported).toEqual([NO_FACTS]);
    });
});

test("a data request for a late build gets a set spanning that build and a build the start reported", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_509);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [GAME, LATE], [0x10n]);
        const running = await run(harness, releases, [GAME]);

        const sent = await askData(running, running.module.dataRequest([LATE]));
        expect(sent.status).toBe(200);
        const answer = running.module.acceptData(sent.bytes);
        expect(setsOf(answer.bundle)).toEqual([{ modules: [GAME, LATE], keys: [0x10n] }]);
        expect(answer.unsupported).toEqual([]);
    });
});

// Over a frame's 1 MiB of plaintext at 8 bytes a key and the same again for its value, with
// headroom for the entries' own framing.
const OVERSIZED_KEYS = Array.from({ length: 100_000 }, (_, index) => BigInt(index + 1));

test("a first data response too large for a frame is unavailable and leaves the start unconsumed", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_510);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [GAME], OVERSIZED_KEYS);
        const member = await entitledMember(harness, {
            email: "big@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(harness.rng));
        await signIn(harness, loader, member.browserSession);
        await enroll(harness, loader, member.browserSession);
        const started = await startOk(loader, releases, [GAME]);
        const module = createTestModule(harness.rng, harness.signer.publicKey);

        const refused = await loader.send({
            method: "POST",
            path: `${started.path}/session`,
            body: await module.hello(releases.module.id),
        });
        expect(refused.status).toBe(503);
        expect(refusalCodeOf(refused)).toBe("SERVICE_UNAVAILABLE");

        const cleared = await execute(nativeDb, sql`delete from current_fact_set`);
        invariant(cleared.ok, "clearing the current sets failed");
        const retried = await loader.send({
            method: "POST",
            path: `${started.path}/session`,
            body: await module.hello(releases.module.id),
        });
        expect(retried.status).toBe(200);
    });
});

test("a data response too large for a frame is unavailable and takes no sequence", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_511);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [LATE], OVERSIZED_KEYS);
        const running = await run(harness, releases, [GAME]);

        const refused = await askData(running, running.module.dataRequest([LATE]));
        expect(refused.status).toBe(503);
        expect(refusalCodeOf(refused)).toBe("SERVICE_UNAVAILABLE");
        const next = await askData(running, running.module.dataRequest([GAME]));
        expect(next.status).toBe(200);
        const answer = running.module.acceptData(next.bytes);
        const sequence = parseFrame(next.bytes);
        invariant(sequence.ok, "the reply is a frame");
        expect(sequence.value.header.sequence).toBe(1n);
        expect(answer.unsupported).toEqual([GAME]);
    });
});

test("a renewal and a data request both succeed in either order, each on its own sequence", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_504);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, [GAME]);
        const renew = async () => {
            const sent = await running.loader.send({
                method: "POST",
                path: `${running.path}/lease`,
                body: running.module.renewal(),
            });
            expect(sent.status).toBe(200);
            await running.module.acceptLease(sent.bytes);
        };

        expect((await askData(running, running.module.dataRequest([GAME]))).status).toBe(200);
        await renew();
        await renew();
        expect((await askData(running, running.module.dataRequest([GAME]))).status).toBe(200);
    });
});

test("a replayed data frame is refused as a stale sequence", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_505);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, [GAME]);

        const frame = running.module.dataRequest([GAME]);
        expect((await askData(running, frame)).status).toBe(200);
        const replayed = await askData(running, frame);
        expect(replayed.status).toBe(409);
        expect(refusalCodeOf(replayed)).toBe("STALE_SEQUENCE");
        const older = await askData(running, running.module.dataRequest([GAME], { sequence: 1n }));
        expect(refusalCodeOf(older)).toBe("STALE_SEQUENCE");
    });
});

test("a retried data request with the same operation id gets the first answer", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_506);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        await currentSet(nativeDb, releases.module.id, [LATE], [0x30n]);
        const running = await run(harness, releases, [GAME]);

        const frame = running.module.dataRequest([LATE]);
        const operationId = newOperationId(rng);
        const first = await askData(running, frame, operationId);
        const retried = await askData(running, frame, operationId);
        expect(retried.status).toBe(200);
        const answers = [first, retried].map((sent) => {
            const parsed = running.module.acceptData(sent.bytes);
            return setsOf(parsed.bundle);
        });
        expect(answers[1]).toEqual(answers[0]);
        const sequenceOf = (sent: { readonly bytes: Uint8Array }) => {
            const parsed = parseFrame(sent.bytes);
            invariant(parsed.ok, "the reply is a frame");
            return parsed.value.header.sequence;
        };
        expect(sequenceOf(retried)).toBe(sequenceOf(first));

        // The next request is a new frame and takes the next sequence.
        const next = await askData(running, running.module.dataRequest([LATE]));
        expect(next.status).toBe(200);
    });
});

test("an ended session refuses data requests", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_507);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, [GAME]);

        const closed = await running.loader.send({
            method: "POST",
            path: `${running.path}/close`,
        });
        expect(closed.status).toBe(204);
        const sent = await askData(running, running.module.dataRequest([GAME]));
        expect(sent.status).toBe(410);
        expect(refusalCodeOf(sent)).toBe("SESSION_ENDED");
    });
});

test("a data body over 64 KiB is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_508);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const running = await run(harness, releases, [GAME]);

        const sent = await askData(running, new Uint8Array(64 * 1024 + 1));
        expect(sent.status).toBe(400);
    });
});
