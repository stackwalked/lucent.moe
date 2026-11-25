import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, toHex } from "@lucent/core/scalars";
import type { ReportEvent } from "@lucent/wire/reports";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/db/pool.ts";
import { MAX_REPORTS_PER_SESSION } from "../src/runtime/reports.rules.ts";
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

type Running = {
    readonly harness: NativeHarness;
    readonly releases: Releases;
    readonly loader: TestLoader;
    readonly module: TestModule;
    readonly path: string;
};

async function runModule(harness: NativeHarness, email: string): Promise<Running> {
    const releases = await publishBoth(harness.db, harness.rng);
    const member = await entitledMember(harness, { email, channels: ["alpha"] });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    return { harness, releases, loader, ...(await openOne(harness, releases, loader)) };
}

async function openOne(harness: NativeHarness, releases: Releases, loader: TestLoader) {
    const started = await startOk(loader, releases);
    const module = createTestModule(harness.rng, harness.signer.publicKey);
    const opened = await loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { module, path: sessionPath(module.session()) };
}

async function post(at: Running, body: Uint8Array, operationId?: string) {
    return await at.loader.send({
        method: "POST",
        path: `${at.path}/reports`,
        body,
        ...(operationId === undefined ? {} : { operationId }),
    });
}

const BATCH: readonly ReportEvent[] = [
    { kind: "health", time: 1_000, eventId: 4, subject: 0x1111n, value: 2 },
    {
        kind: "crash",
        time: 2_000,
        exceptionCode: 0xc000_0005,
        moduleHash: 0n,
        rva: 0x1a2b0,
        frames: [0x1a2b0, 0x1c004],
    },
    {
        kind: "crash",
        time: 3_000,
        exceptionCode: 0xc000_0409,
        moduleHash: 0x8000_0000_0000_0001n,
        rva: 0x400,
        frames: [],
    },
];

const StoredRow = z.object({
    product_id: z.string(),
    release_id: z.instanceof(Uint8Array),
    kind: z.string(),
    session_ms: z.coerce.number(),
    module_hash: z.string().nullable(),
    rva: z.coerce.number().nullable(),
    frames: z.array(z.coerce.number()).nullable(),
});

async function stored(db: Db) {
    const rows = await queryAll(
        db,
        StoredRow,
        sql`select product_id, release_id, kind, session_ms, module_hash::text, rva, frames
            from module_report order by id`,
    );
    invariant(rows.ok, "reading module_report failed");
    return rows.value;
}

test("a module's batch is stored under its product and release, the ack counts it, and a retry stores nothing twice", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_801)),
            "reports@lucent.test",
        );
        const batch = at.module.reports(BATCH);
        const operationId = newOperationId(at.harness.rng);

        const first = await post(at, batch, operationId);
        expect(first.status).toBe(200);
        expect(at.module.acceptReports(first.bytes)).toEqual({
            sequence: 1n,
            ack: { answers: 1n, accepted: 3 },
        });
        const retried = await post(at, batch, operationId);
        expect(retried.status).toBe(200);
        expect(at.module.acceptReports(retried.bytes)).toEqual({
            sequence: 1n,
            ack: { answers: 1n, accepted: 3 },
        });

        const rows = await stored(nativeDb);
        expect(rows.map((row) => [row.kind, row.session_ms])).toEqual([
            ["health", 1_000],
            ["crash", 2_000],
            ["crash", 3_000],
        ]);
        expect(new Set(rows.map((row) => `${row.product_id}:${toHex(row.release_id)}`))).toEqual(
            new Set([`cs2:${toHex(at.releases.module.id)}`]),
        );
        expect(rows[1]).toMatchObject({
            module_hash: "0",
            rva: 0x1a2b0,
            frames: [0x1a2b0, 0x1c004],
        });
        expect(rows[2]).toMatchObject({ module_hash: "9223372036854775809", frames: [] });

        const next = await post(at, at.module.reports(BATCH.slice(0, 1)));
        expect(at.module.acceptReports(next.bytes)).toEqual({
            sequence: 2n,
            ack: { answers: 2n, accepted: 1 },
        });
        expect(await stored(nativeDb)).toHaveLength(4);
    });
});

test("a reports frame no newer than the last accepted is stale, and nothing of it is stored", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_802)),
            "stale-reports@lucent.test",
        );
        expect((await post(at, at.module.reports(BATCH, { sequence: 5n }))).status).toBe(200);

        for (const sequence of [5n, 4n]) {
            const stale = await post(at, at.module.reports(BATCH, { sequence }));
            expect(refusalCodeOf(stale)).toBe("STALE_SEQUENCE");
        }
        expect(await stored(nativeDb)).toHaveLength(3);
    });
});

test("the reports route opens only frames sealed under its own key", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_803)),
            "keys-reports@lucent.test",
        );
        // A data-route frame at a fresh reports sequence: right session, wrong key.
        const dataFrame = at.module.cloudRequest({ operation: "list" }, { sequence: 1n });

        expect(refusalCodeOf(await post(at, dataFrame))).toBe("PROOF_INVALID");
        expect(await stored(nativeDb)).toHaveLength(0);
    });
});

test("a session past its stored-report cap is acked with only what it kept", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_804)),
            "cap-reports@lucent.test",
        );
        const filled = await execute(
            nativeDb,
            sql`update runtime_session set reports_accepted = ${MAX_REPORTS_PER_SESSION - 2}
                where id = ${at.module.session()}`,
        );
        invariant(filled.ok, "filling the session's reports failed");

        const near = await post(at, at.module.reports(BATCH));
        expect(at.module.acceptReports(near.bytes).ack.accepted).toBe(2);
        const full = await post(at, at.module.reports(BATCH));
        expect(at.module.acceptReports(full.bytes)).toEqual({
            sequence: 2n,
            ack: { answers: 2n, accepted: 0 },
        });
        expect((await stored(nativeDb)).map((row) => row.session_ms)).toEqual([1_000, 2_000]);
    });
});

test("a session whose slot was taken is refused on the reports route, and one from before the route has none", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_805));
        const first = await runModule(harness, "ended-reports@lucent.test");
        const second = { ...first, ...(await openOne(harness, first.releases, first.loader)) };

        expect(refusalCodeOf(await post(first, first.module.reports(BATCH)))).toBe("SLOT_TAKEN");

        const keyless = await execute(
            nativeDb,
            sql`update runtime_session set reports_key_to_server = null, reports_key_to_module = null
                where id = ${second.module.session()}`,
        );
        invariant(keyless.ok, "clearing the reports keys failed");
        expect(refusalCodeOf(await post(second, second.module.reports(BATCH)))).toBe("NOT_FOUND");
        expect(await stored(nativeDb)).toHaveLength(0);
    });
});

test("a trap in the module's own image becomes a risk signal on its session, and an honest crash does not", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_806)),
            "trap-reports@lucent.test",
        );
        const trap: ReportEvent = {
            kind: "crash",
            time: 4_000,
            exceptionCode: 0x8000_0004,
            moduleHash: 0n,
            rva: 0x2000,
            frames: [],
        };
        expect((await post(at, at.module.reports(BATCH))).status).toBe(200);
        expect((await post(at, at.module.reports([trap]))).status).toBe(200);

        const signals = await queryAll(
            nativeDb,
            z.object({ kind: z.string(), session_id: z.instanceof(Uint8Array) }),
            sql`select kind, session_id from risk_signal order by id`,
        );
        invariant(signals.ok, "reading risk_signal failed");
        expect(signals.value.map((row) => [row.kind, toHex(row.session_id)])).toEqual([
            ["module_trap", toHex(at.module.session())],
        ]);
    });
});
