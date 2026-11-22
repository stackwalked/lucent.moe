import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs, newOperationId, toHex } from "@lucent/core/scalars";
import { z } from "zod";
import { execute, sql } from "../src/db/pool.ts";
import { sweepNative } from "../src/runtime/expiry.ts";
import { scalar } from "./authority-fixtures.ts";
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

type Running = { readonly loader: TestLoader; readonly module: TestModule; readonly path: string };

async function enrolledLoader(
    harness: NativeHarness,
    member: Awaited<ReturnType<typeof entitledMember>>,
): Promise<TestLoader> {
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    return loader;
}

async function run(
    harness: NativeHarness,
    loader: TestLoader,
    releases: Releases,
): Promise<Running> {
    const started = await startOk(loader, releases);
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

function renew(running: Running, operationId?: string) {
    return running.loader.send({
        method: "POST",
        path: `${running.path}/lease`,
        body: running.module.renewal(),
        ...(operationId === undefined ? {} : { operationId }),
    });
}

test("a session's first lease binds its device, release and entitled features, and renewals move its sequence on", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_301);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "lease@lucent.test",
            channels: ["alpha"],
            features: ["esp"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        const first = running.module.held();
        expect(first.sequence).toBe(1n);
        expect(first.durationMs).toBe(60_000);
        expect(first.product).toBe("cs2");
        expect(first.release).toEqual(releases.module.id);
        expect(first.entitled).toEqual({ everything: false, features: [FEATURES[1].key] });

        const renewed = await renew(running);
        expect(renewed.status).toBe(200);
        expect((await running.module.acceptLease(renewed.bytes)).sequence).toBe(2n);
        const again = await renew(running);
        expect((await running.module.acceptLease(again.bytes)).sequence).toBe(3n);

        // What the module reported is kept as it came.
        const signals = await scalar(
            nativeDb,
            z.instanceof(Uint8Array),
            sql`select signals as value from lease_renewal where sequence = 3`,
        );
        expect(signals).toEqual(new Uint8Array(64).fill(1));
    });
});

test("a renewal that isn't the next sequence or comes in an old frame is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_302);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "seq@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);

        const body = running.module.renewal();
        const sent = (operationId: string) =>
            running.loader.send({
                method: "POST",
                path: `${running.path}/lease`,
                body,
                operationId,
            });
        const operationId = newOperationId(rng);
        const accepted = await sent(operationId);
        expect(accepted.status).toBe(200);
        // A retry of the same request gets the same lease, signed again.
        const retried = await sent(operationId);
        expect(retried.status).toBe(200);
        expect((await running.module.acceptLease(retried.bytes)).sequence).toBe(2n);
        // The same frame as a new operation is a replay.
        expect(refusalCodeOf(await sent(newOperationId(rng)))).toBe("STALE_SEQUENCE");
    });
});

test("the newest session takes the slot, and the old one is refused at its next renewal", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_303);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "slot@lucent.test",
            channels: ["alpha"],
        });
        const loader = await enrolledLoader(harness, member);
        const old = await run(harness, loader, releases);
        const newer = await run(harness, loader, releases);

        expect(refusalCodeOf(await renew(old))).toBe("SLOT_TAKEN");
        // The answer stays the same however often it asks.
        expect(refusalCodeOf(await renew(old))).toBe("SLOT_TAKEN");
        const renewed = await renew(newer);
        expect(renewed.status).toBe(200);
        expect(
            await scalar(
                nativeDb,
                z.string(),
                sql`select encode(holder_session, 'hex') as value from product_slot`,
            ),
        ).toBe(toHex(newer.module.session()));
    });
});

test("a suspension ends the session at its next renewal", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_304);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "cut@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        await execute(
            nativeDb,
            sql`update account set status = 'suspended' where id = ${member.accountId}`,
        );
        expect(refusalCodeOf(await renew(running))).toBe("ACCOUNT_SUSPENDED");
        await execute(
            nativeDb,
            sql`update account set status = 'active' where id = ${member.accountId}`,
        );
        expect(refusalCodeOf(await renew(running))).toBe("ACCOUNT_SUSPENDED");
    });
});

test("a lapsed lease resumes within five minutes and ends after", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_305);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "lapse@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);

        await execute(
            nativeDb,
            sql`update runtime_session set lease_expires_at = now() - interval '4 minutes'`,
        );
        const resumed = await renew(running);
        expect(resumed.status).toBe(200);
        await running.module.acceptLease(resumed.bytes);

        await execute(
            nativeDb,
            sql`update runtime_session set lease_expires_at = now() - interval '5 minutes 1 second'`,
        );
        expect(refusalCodeOf(await renew(running))).toBe("SESSION_ENDED");
        expect(
            await scalar(
                nativeDb,
                z.string(),
                sql`select end_reason as value from runtime_session`,
            ),
        ).toBe("expired");
    });
});

test("a session ends after twelve hours however it renews", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_306);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "cap@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        await execute(
            nativeDb,
            sql`update runtime_session set created_at = now() - interval '12 hours'`,
        );
        expect(refusalCodeOf(await renew(running))).toBe("SESSION_ENDED");
    });
});

test("closing frees the slot at once and the session renews no more", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_307);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "bye@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        const close = () =>
            running.loader.send({
                method: "POST",
                path: `${running.path}/close`,
                operationId: null,
            });
        expect((await close()).status).toBe(204);
        expect((await close()).status).toBe(204);
        expect(
            await scalar(
                nativeDb,
                z.boolean(),
                sql`select holder_session is null as value from product_slot`,
            ),
        ).toBe(true);
        expect(refusalCodeOf(await renew(running))).toBe("SESSION_ENDED");
    });
});

test("another PC of the same account can't drive a session", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_308);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "two@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        const other = createTestLoader(harness, await createTestDevice(rng));
        await signIn(harness, other, member.browserSession);
        const sent = await other.send({
            method: "POST",
            path: `${running.path}/lease`,
            body: running.module.renewal(),
        });
        expect(refusalCodeOf(sent)).toBe("NOT_FOUND");
    });
});

test("renewals past a key's per-minute allowance are refused with a retry-after", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_309);
        let now = 1_000_000;
        const harness = await createNativeHarness(nativeDb, rng, {
            clock: { now: () => EpochMs.parse(now) },
            rateLimits: { "sessions.lease": { perMinute: 2 } },
        });
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "busy@lucent.test",
            channels: ["alpha"],
        });
        const running = await run(harness, await enrolledLoader(harness, member), releases);
        const first = await renew(running);
        await running.module.acceptLease(first.bytes);
        const second = await renew(running);
        await running.module.acceptLease(second.bytes);
        const third = await renew(running);
        expect(third.status).toBe(429);
        expect(refusalCodeOf(third)).toBe("RATE_LIMITED");
        now += 30_000;
        expect((await renew(running)).status).toBe(200);
    });
});

test("a vanished loader's session is ended by the sweep once it can no longer resume, freeing its slot", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_310);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "gone@lucent.test",
            channels: ["alpha"],
        });
        await run(harness, await enrolledLoader(harness, member), releases);
        const swept = await sweepNative(nativeDb);
        expect(swept.ok).toBe(true);
        expect(
            await scalar(
                nativeDb,
                z.boolean(),
                sql`select ended_at is null as value from runtime_session`,
            ),
        ).toBe(true);

        await execute(
            nativeDb,
            sql`update runtime_session set lease_expires_at = now() - interval '6 minutes'`,
        );
        await sweepNative(nativeDb);
        expect(
            await scalar(
                nativeDb,
                z.string(),
                sql`select end_reason || ' ' || (key_to_module is null)::text as value from runtime_session`,
            ),
        ).toBe("expired true");
        expect(
            await scalar(
                nativeDb,
                z.boolean(),
                sql`select holder_session is null as value from product_slot`,
            ),
        ).toBe(true);
    });
});
