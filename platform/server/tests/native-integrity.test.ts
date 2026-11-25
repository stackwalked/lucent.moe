import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId } from "@lucent/core/scalars";
import { SIGNALS_SIZE } from "@lucent/wire/lease";
import { toRenewalBitsBytes } from "@lucent/wire/renewal-bits";
import { z } from "zod";
import { type Db, queryAll, sql } from "../src/db/pool.ts";
import { scalar } from "./authority-fixtures.ts";
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
    refusalCodeOf,
    sessionPath,
    signIn,
    startOk,
    type TestLoader,
    type TestModule,
} from "./native-fixtures.ts";

type Running = {
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

// The loader answers every challenge, so the only signals are the field's.
const ANSWER = new Uint8Array(32).fill(0x5c);

function renew(running: Running, signals: Uint8Array, operationId?: string) {
    return running.loader.send({
        method: "POST",
        path: `${running.path}/lease`,
        body: running.module.renewal({ loaderAnswer: ANSWER, signals }),
        ...(operationId === undefined ? {} : { operationId }),
    });
}

async function signalKinds(db: Db): Promise<readonly string[]> {
    const rows = await queryAll(
        db,
        z.object({ kind: z.string() }),
        sql`select kind from risk_signal order by id`,
    );
    invariant(rows.ok, "reading risk_signal failed");
    return rows.value.map((row) => row.kind);
}

const BITS = toRenewalBitsBytes({
    flags: {
        debugger: true,
        hardwareBreakpoints: false,
        kernelDebugging: false,
        testSigning: true,
        signatureEnforcementOff: false,
        codeWritable: false,
    },
    vmVendor: "vmware",
    windowsBuild: 26_100,
    moduleSlots: [0n, 0x77n, 0n, 0x77n],
});

test("a renewal with integrity bits set yields the signals the rules name, once however often it is retried", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const running = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_901)),
            "bits@lucent.test",
        );
        const body = running.module.renewal({ loaderAnswer: ANSWER, signals: BITS });
        const operationId = newOperationId(createSeededRng(9_902));
        const send = () =>
            running.loader.send({
                method: "POST",
                path: `${running.path}/lease`,
                body,
                operationId,
            });

        const first = await send();
        expect(first.status).toBe(200);
        const retried = await send();
        expect(retried.status).toBe(200);
        await running.module.acceptLease(first.bytes);

        expect(await signalKinds(nativeDb)).toEqual([
            "debugger_attached",
            "test_signing",
            "virtual_machine",
            "unsigned_module",
        ]);
        expect(
            await scalar(
                nativeDb,
                z.instanceof(Uint8Array),
                sql`select signals as value from lease_renewal where sequence = 2`,
            ),
        ).toEqual(BITS);
    });
});

test("a renewal with an all-zero field yields no signal", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const running = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_903)),
            "clean@lucent.test",
        );
        for (let renewal = 0; renewal < 2; renewal += 1) {
            const renewed = await renew(running, new Uint8Array(SIGNALS_SIZE));
            expect(renewed.status).toBe(200);
            await running.module.acceptLease(renewed.bytes);
        }

        expect(await signalKinds(nativeDb)).toEqual([]);
    });
});

test("a renewal with a reserved bit or byte set is refused and writes nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const running = await runModule(
            await createNativeHarness(nativeDb, createSeededRng(9_904)),
            "reserved@lucent.test",
        );
        const reservedBit = BITS.slice();
        reservedBit[0] = (reservedBit[0] ?? 0) | 0x40;
        const reservedByte = new Uint8Array(SIGNALS_SIZE);
        reservedByte[17] = 1;

        for (const signals of [reservedBit, reservedByte]) {
            expect(refusalCodeOf(await renew(running, signals))).toBe("INVALID_REQUEST");
        }
        expect(await signalKinds(nativeDb)).toEqual([]);
        expect(
            await scalar(
                nativeDb,
                z.coerce.number(),
                sql`select count(*) as value from lease_renewal`,
            ),
        ).toBe(0);
        expect(
            await scalar(
                nativeDb,
                z.coerce.number(),
                sql`select lease_sequence as value from runtime_session`,
            ),
        ).toBe(1);
        // The session goes on: a well-formed renewal after the refusals is the lease it asked for.
        const renewed = await renew(running, new Uint8Array(SIGNALS_SIZE));
        expect((await running.module.acceptLease(renewed.bytes)).sequence).toBe(2n);
    });
});
