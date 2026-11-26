import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, toHex } from "@lucent/core/scalars";
import { parseEnrollmentStatus, toEnrollmentRequestBytes } from "@lucent/wire/enrollment";
import { z } from "zod";
import { matchCodeOf } from "../src/base/core/ids.ts";
import { execute, sql } from "../src/base/db/pool.ts";
import { hashToken } from "../src/identity/auth/tokens.ts";
import {
    approveEnrollment,
    denyEnrollment,
    listDevices,
    listPendingEnrollments,
} from "../src/identity/devices/devices.ts";
import { scalar } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    type NativeHarness,
    refusalCodeOf,
    signIn,
    type TestLoader,
} from "./native-fixtures.ts";

async function requestEnrollment(loader: TestLoader) {
    const sent = await loader.send({
        method: "POST",
        path: "/v1/enrollments",
        body: toEnrollmentRequestBytes({ storage: "software" }),
    });
    return { sent, status: parseEnrollmentStatus(sent.bytes) };
}

async function signedInLoader(
    harness: NativeHarness,
    browserSession: Parameters<typeof signIn>[2],
) {
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, browserSession);
    return loader;
}

test("an enrollment waits for the member to confirm the code its loader shows, then names the device", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_101);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "enroll@lucent.test",
            channels: ["alpha"],
        });
        const loader = await signedInLoader(harness, member.browserSession);

        const requested = await requestEnrollment(loader);
        invariant(requested.status.ok, "the enrollment is accepted");
        expect(requested.status.value.state).toBe("pending");
        const id = requested.status.value.enrollment;
        const poll = async () => {
            const sent = await loader.send({ method: "GET", path: `/v1/enrollments/${toHex(id)}` });
            const status = parseEnrollmentStatus(sent.bytes);
            invariant(status.ok, `polling failed: ${refusalCodeOf(sent)}`);
            return status.value;
        };
        expect((await poll()).state).toBe("pending");

        const listed = await listPendingEnrollments(nativeDb, {
            sessionToken: member.browserSession,
        });
        invariant(listed.ok, "web lists pending enrollments");
        expect(listed.value).toEqual([
            expect.objectContaining({
                enrollmentId: toHex(id),
                matchCode: matchCodeOf(loader.device.jkt),
                storage: "software",
            }),
        ]);

        const approved = await approveEnrollment(nativeDb, {
            rng,
            sessionToken: member.browserSession,
            operationId: newOperationId(rng),
            enrollmentId: id,
        });
        invariant(approved.ok, `approval failed: ${JSON.stringify(approved)}`);
        expect(approved.value.replaced).toBe(false);
        const polled = await poll();
        expect(polled.state === "approved" && toHex(polled.device)).toBe(approved.value.deviceId);

        const devices = await listDevices(nativeDb, { sessionToken: member.browserSession });
        invariant(devices.ok, "web lists devices");
        expect(devices.value.devices.map((device) => device.storage)).toEqual(["software"]);
        expect(refusalCodeOf((await requestEnrollment(loader)).sent)).toBe("ALREADY_ENROLLED");
    });
});

test("approving an enrollment needs a factor proven in the last five minutes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_102);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "fresh@lucent.test",
            channels: ["alpha"],
        });
        const loader = await signedInLoader(harness, member.browserSession);
        const requested = await requestEnrollment(loader);
        invariant(requested.status.ok, "the enrollment is accepted");
        await execute(
            nativeDb,
            sql`update browser_session set authenticated_at = now() - interval '6 minutes'
                where token_hash = ${await hashToken(member.browserSession)}`,
        );
        expect(
            await approveEnrollment(nativeDb, {
                rng,
                sessionToken: member.browserSession,
                operationId: newOperationId(rng),
                enrollmentId: requested.status.value.enrollment,
            }),
        ).toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", withinSeconds: 300 } });
    });
});

test("a key enrolled to one account is refused to another", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_103);
        const harness = await createNativeHarness(nativeDb, rng);
        const alice = await entitledMember(harness, {
            email: "alice@lucent.test",
            channels: ["alpha"],
        });
        const bob = await entitledMember(harness, {
            email: "bob@lucent.test",
            channels: ["alpha"],
        });
        const device = await createTestDevice(rng);
        const aliceLoader = createTestLoader(harness, device);
        await signIn(harness, aliceLoader, alice.browserSession);
        await enroll(harness, aliceLoader, alice.browserSession);

        const bobLoader = createTestLoader(harness, device);
        await signIn(harness, bobLoader, bob.browserSession);
        expect(refusalCodeOf((await requestEnrollment(bobLoader)).sent)).toBe("KEY_IN_USE");
    });
});

test("a second PC replaces the first once a week, and is refused while the window is closed", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_104);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "swap@lucent.test",
            channels: ["alpha"],
        });
        const first = await signedInLoader(harness, member.browserSession);
        const firstDevice = await enroll(harness, first, member.browserSession);

        const second = await signedInLoader(harness, member.browserSession);
        const requested = await requestEnrollment(second);
        invariant(requested.status.ok, "the first replacement is allowed");
        const approved = await approveEnrollment(nativeDb, {
            rng,
            sessionToken: member.browserSession,
            operationId: newOperationId(rng),
            enrollmentId: requested.status.value.enrollment,
        });
        invariant(approved.ok, "the replacement is approved");
        expect(approved.value.replaced).toBe(true);
        expect(
            await scalar(
                nativeDb,
                z.boolean(),
                sql`select revoked_at is not null as value from device where id = ${firstDevice}`,
            ),
        ).toBe(true);

        const third = await signedInLoader(harness, member.browserSession);
        expect(refusalCodeOf((await requestEnrollment(third)).sent)).toBe("ENROLLMENT_LIMIT");
        const devices = await listDevices(nativeDb, { sessionToken: member.browserSession });
        expect(devices.ok && devices.value.replaceableFrom !== null).toBe(true);

        await execute(
            nativeDb,
            sql`update device_change_window set last_replaced_at = now() - interval '7 days'`,
        );
        const reopened = await requestEnrollment(third);
        expect(reopened.status.ok && reopened.status.value.state).toBe("pending");
    });
});

test("a denied enrollment reads as denied and can't be approved after", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_105);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "nope@lucent.test",
            channels: ["alpha"],
        });
        const loader = await signedInLoader(harness, member.browserSession);
        const requested = await requestEnrollment(loader);
        invariant(requested.status.ok, "the enrollment is accepted");
        const enrollmentId = requested.status.value.enrollment;
        expect(
            await denyEnrollment(nativeDb, { sessionToken: member.browserSession, enrollmentId }),
        ).toEqual({ ok: true, value: undefined });
        const polled = await loader.send({
            method: "GET",
            path: `/v1/enrollments/${toHex(enrollmentId)}`,
        });
        const status = parseEnrollmentStatus(polled.bytes);
        expect(status.ok && status.value.state).toBe("denied");
        expect(
            await approveEnrollment(nativeDb, {
                rng,
                sessionToken: member.browserSession,
                operationId: newOperationId(rng),
                enrollmentId,
            }),
        ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    });
});

test("a pending enrollment expires after ten minutes and a new request starts another", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_106);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "late@lucent.test",
            channels: ["alpha"],
        });
        const loader = await signedInLoader(harness, member.browserSession);
        const first = await requestEnrollment(loader);
        invariant(first.status.ok, "the enrollment is accepted");
        const again = await requestEnrollment(loader);
        invariant(again.status.ok, "asking again is accepted");
        expect(toHex(again.status.value.enrollment)).toBe(toHex(first.status.value.enrollment));

        await execute(
            nativeDb,
            sql`update device_enrollment set expires_at = now() - interval '1 second'`,
        );
        const polled = await loader.send({
            method: "GET",
            path: `/v1/enrollments/${toHex(first.status.value.enrollment)}`,
        });
        const status = parseEnrollmentStatus(polled.bytes);
        expect(status.ok && status.value.state).toBe("expired");
        const fresh = await requestEnrollment(loader);
        invariant(fresh.status.ok, "a new request is accepted");
        expect(toHex(fresh.status.value.enrollment)).not.toBe(toHex(first.status.value.enrollment));
    });
});
