import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { AccountId, newOperationId, ProductId, toHex } from "@lucent/core/scalars";
import type { ReportEvent } from "@lucent/wire/reports";
import { z } from "zod";
import { revokeAccess } from "../src/auth/revoke-access.ts";
import { type Db, execute, queryAll, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { sweepRetention } from "../src/jobs/retention.ts";
import { listCrashSummaries } from "../src/runtime/crashes.ts";
import { sweepNative } from "../src/runtime/expiry.ts";
import {
    MAX_REPORTS_PER_ACCOUNT_DAY,
    MAX_REPORTS_PER_SESSION,
} from "../src/runtime/reports.rules.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import { seedRole, seedStaff, steppedUp } from "./authority-fixtures.ts";
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

test("a reported crash appears on the staff crash list under its release, grouped by module and RVA, newest first", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_807));
        const at = await runModule(harness, "crash-list@lucent.test");
        expect((await post(at, at.module.reports(BATCH))).status).toBe(200);
        const again: ReportEvent = {
            kind: "crash",
            time: 9_000,
            exceptionCode: 0xc000_001d,
            moduleHash: 0n,
            rva: 0x1a2b0,
            frames: [0x1a2b0, 0x1c004],
        };
        expect((await post(at, at.module.reports([again]))).status).toBe(200);
        const caller = await steppedUp(nativeDb, await seedRootOnce(nativeDb, harness.rng));

        const listed = await listCrashSummaries(nativeDb, {
            caller,
            productId: null,
            releaseId: toHex(at.releases.module.id),
            cursor: null,
        });
        invariant(listed.ok, `listing crashes failed: ${JSON.stringify(listed)}`);
        expect(listed.value.nextCursor).toBeNull();
        expect(
            listed.value.items.map((item) => ({
                product: String(item.productId),
                release: item.releaseId,
                channel: String(item.channel),
                seal: item.sealNumber,
                module: item.moduleHash,
                rva: item.rva,
                crashes: item.crashes,
                code: item.exceptionCode,
                frames: item.frames,
            })),
        ).toEqual([
            {
                product: "cs2",
                release: toHex(at.releases.module.id),
                channel: "alpha",
                seal: "1",
                module: "0000000000000000",
                rva: 0x1a2b0,
                crashes: 2,
                code: 0xc000_001d,
                frames: [0x1a2b0, 0x1c004],
            },
            {
                product: "cs2",
                release: toHex(at.releases.module.id),
                channel: "alpha",
                seal: "1",
                module: "8000000000000001",
                rva: 0x400,
                crashes: 1,
                code: 0xc000_0409,
                frames: [],
            },
        ]);
        const elsewhere = await listCrashSummaries(nativeDb, {
            caller,
            productId: ProductId.parse("other"),
            releaseId: null,
            cursor: null,
        });
        expect(elsewhere.ok && elsewhere.value.items).toEqual([]);
    });
});

test("the crash list pages by its newest crash, refuses a cursor it didn't hand out, and needs the review action", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_808);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const seeded = await execute(
            nativeDb,
            sql`insert into module_report
                    (product_id, release_id, received_at, session_ms, kind, exception_code,
                     module_hash, rva, frames)
                select 'cs2', ${releases.module.id}, now() - make_interval(secs => n), 0, 'crash',
                       3221225477, 0, n, '{}'
                from generate_series(1, 51) as n`,
        );
        invariant(seeded.ok, "seeding crashes failed");
        const caller = await steppedUp(nativeDb, await seedRootOnce(nativeDb, harness.rng));
        const page = (cursor: string | null) =>
            listCrashSummaries(nativeDb, { caller, productId: null, releaseId: null, cursor });

        const first = await page(null);
        invariant(first.ok && first.value.nextCursor !== null, "a first page with more after it");
        expect(first.value.items.map((item) => item.rva)).toEqual(
            Array.from({ length: 50 }, (_, index) => index + 1),
        );
        const second = await page(first.value.nextCursor);
        expect(second.ok && second.value).toEqual({
            items: [expect.objectContaining({ rva: 51 })],
            nextCursor: null,
        });
        expect(await page("bm90LWEtY3Vyc29y")).toEqual({
            ok: false,
            error: { code: "INVALID_CURSOR" },
        });

        const readerRole = await seedRole(nativeDb, {
            id: "role_reader",
            rank: 10,
            permissions: ["accounts:read"],
        });
        const reader = await seedStaff(nativeDb, rng, {
            email: "reader@lucent.test",
            roleId: readerRole,
        });
        expect(
            await listCrashSummaries(nativeDb, {
                caller: await steppedUp(nativeDb, reader),
                productId: null,
                releaseId: null,
                cursor: null,
            }),
        ).toEqual({ ok: false, error: { code: "FORBIDDEN" } });
    });
});

const KEY_COLUMNS = sql`key_to_server, key_to_module, data_key_to_server, data_key_to_module,
    reports_key_to_server, reports_key_to_module`;

async function heldKeys(db: Db, session: Uint8Array): Promise<number> {
    const row = await queryAll(
        db,
        z.object({ held: z.coerce.number() }),
        sql`select num_nonnulls(${KEY_COLUMNS}) as held from runtime_session where id = ${session}`,
    );
    invariant(row.ok && row.value[0] !== undefined, "reading the session's keys failed");
    return row.value[0].held;
}

test("a session the expiry sweep ends, and one ended by revoking access, keeps no key of any route", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_809));
        const lapsed = await runModule(harness, "lapsed-keys@lucent.test");
        const revoked = await runModule(harness, "revoked-keys@lucent.test");
        expect(await heldKeys(nativeDb, lapsed.module.session())).toBe(6);

        const aged = await execute(
            nativeDb,
            sql`update runtime_session set lease_expires_at = now() - interval '1 hour'
                where id = ${lapsed.module.session()}`,
        );
        invariant(aged.ok, "ageing the lease failed");
        const swept = await sweepNative(nativeDb);
        invariant(swept.ok, "the expiry sweep failed");
        expect(await heldKeys(nativeDb, lapsed.module.session())).toBe(0);

        const owner = await queryAll(
            nativeDb,
            z.object({ account_id: AccountId }),
            sql`select account_id from runtime_session where id = ${revoked.module.session()}`,
        );
        invariant(owner.ok && owner.value[0] !== undefined, "reading the session's account failed");
        const accountId = owner.value[0].account_id;
        const done = await withTx(nativeDb, (tx) => revokeAccess(tx, accountId));
        invariant(done.ok, "revoking access failed");
        expect(await heldKeys(nativeDb, revoked.module.session())).toBe(0);
    });
});

test("a stored report's time is the hour it arrived, not the moment", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const at = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_810)),
            "hour@lucent.test",
        );
        expect((await post(at, at.module.reports(BATCH))).status).toBe(200);

        const times = await queryAll(
            nativeDb,
            z.object({ off_hour: z.boolean(), recent: z.boolean() }),
            sql`select received_at <> date_trunc('hour', received_at, 'UTC') as off_hour,
                       received_at > now() - interval '1 hour' as recent
                from module_report`,
        );
        invariant(times.ok, "reading report times failed");
        expect(times.value).toEqual(Array(3).fill({ off_hour: false, recent: true }));
    });
});

test("an account's sessions of the last day share one cap on stored events", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_811));
        const first = await runModule(harness, "day-cap@lucent.test");
        // An earlier session of the day stored all but one; once it is two days old, it no longer
        // counts.
        const filled = await execute(
            nativeDb,
            sql`update runtime_session
                set reports_accepted = ${MAX_REPORTS_PER_ACCOUNT_DAY - 1}
                where id = ${first.module.session()}`,
        );
        invariant(filled.ok, "filling the first session failed");
        const second = { ...first, ...(await openOne(harness, first.releases, first.loader)) };

        const acked = await post(second, second.module.reports(BATCH));
        expect(second.module.acceptReports(acked.bytes).ack.accepted).toBe(1);

        const aged = await execute(
            nativeDb,
            sql`update runtime_session set created_at = now() - interval '2 days'
                where id = ${first.module.session()}`,
        );
        invariant(aged.ok, "ageing the first session failed");
        const later = await post(second, second.module.reports(BATCH));
        expect(second.module.acceptReports(later.bytes).ack.accepted).toBe(3);
        expect(await stored(nativeDb)).toHaveLength(4);
    });
});

test("retention removes reports past 30 days and keeps newer ones", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_812);
        const releases = await publishBoth(nativeDb, rng);
        const seeded = await execute(
            nativeDb,
            sql`insert into module_report
                    (product_id, release_id, received_at, session_ms, kind, event_id, subject, value)
                select 'cs2', ${releases.module.id}, now() - make_interval(days => d), d, 'health',
                       1, 0, 0
                from unnest(array[1, 29, 31, 90]) as d`,
        );
        invariant(seeded.ok, "seeding reports failed");

        const swept = await sweepRetention(nativeDb);
        invariant(swept.ok, "the retention sweep failed");
        const kept = await queryAll(
            nativeDb,
            z.object({ session_ms: z.coerce.number() }),
            sql`select session_ms from module_report order by session_ms`,
        );
        expect(kept.ok && kept.value.map((row) => row.session_ms)).toEqual([1, 29]);
    });
});
