import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId } from "@lucent/core/scalars";
import { hashToken } from "../src/auth/tokens.ts";
import { execute, sql } from "../src/db/pool.ts";
import { listMemberProducts } from "../src/internal/products.ts";
import { listDevices, removeDevice, renameDevice } from "../src/native/devices.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    type Member,
    type NativeHarness,
    publishRelease,
    signIn,
} from "./native-fixtures.ts";

async function enrolledDevice(harness: NativeHarness, member: Member): Promise<Uint8Array> {
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    return await enroll(harness, loader, member.browserSession);
}

test("removing a PC is the week's self-service change: the next removal waits for the window", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_301);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "remove@lucent.test",
            channels: ["alpha"],
        });
        const remove = (deviceId: Uint8Array) =>
            removeDevice(nativeDb, {
                sessionToken: member.browserSession,
                operationId: newOperationId(rng),
                deviceId,
            });

        const first = await enrolledDevice(harness, member);
        expect(await remove(first)).toEqual({ ok: true, value: undefined });
        const listed = await listDevices(nativeDb, { sessionToken: member.browserSession });
        invariant(listed.ok, "web lists devices");
        expect(listed.value.devices).toEqual([]);
        expect(listed.value.replaceableFrom).not.toBeNull();

        // Below the limit, enrolling consults no window; removing again does.
        const second = await enrolledDevice(harness, member);
        expect(await remove(second)).toEqual({
            ok: false,
            error: { code: "DEVICE_CHANGE_TOO_SOON" },
        });
        await execute(
            nativeDb,
            sql`update device_change_window set last_replaced_at = now() - interval '8 days'`,
        );
        expect(await remove(second)).toEqual({ ok: true, value: undefined });
    });
});

test("removing a PC needs a factor proven in the last five minutes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_302);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "stale@lucent.test",
            channels: ["alpha"],
        });
        const deviceId = await enrolledDevice(harness, member);
        await execute(
            nativeDb,
            sql`update browser_session set authenticated_at = now() - interval '6 minutes'
                where token_hash = ${await hashToken(member.browserSession)}`,
        );
        expect(
            await removeDevice(nativeDb, {
                sessionToken: member.browserSession,
                operationId: newOperationId(rng),
                deviceId,
            }),
        ).toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", withinSeconds: 300 } });
    });
});

test("a PC is renamed only by its own account", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_303);
        const harness = await createNativeHarness(nativeDb, rng);
        const alice = await entitledMember(harness, {
            email: "alice@lucent.test",
            channels: ["alpha"],
        });
        const bob = await entitledMember(harness, {
            email: "bob@lucent.test",
            channels: ["alpha"],
        });
        const deviceId = await enrolledDevice(harness, alice);

        expect(
            await renameDevice(nativeDb, {
                sessionToken: bob.browserSession,
                deviceId,
                name: "not mine",
            }),
        ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
        expect(
            await renameDevice(nativeDb, {
                sessionToken: alice.browserSession,
                deviceId,
                name: "desk",
            }),
        ).toEqual({ ok: true, value: undefined });
        const listed = await listDevices(nativeDb, { sessionToken: alice.browserSession });
        invariant(listed.ok, "web lists devices");
        expect(listed.value.devices.map((device) => device.name)).toEqual(["desk"]);
    });
});

test("a member's products are the ones entitled now, each channel with its promoted release or none", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_304);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "products@lucent.test",
            channels: ["stable", "alpha"],
        });
        await publishRelease(nativeDb, rng, { product: "cs2", channel: "alpha" });

        const listed = await listMemberProducts(nativeDb, {
            catalog: harness.catalog,
            sessionToken: member.browserSession,
        });
        invariant(listed.ok, "web lists products");
        // Compared as plain data: the listed ids are branded.
        const products: unknown = listed.value;
        expect(products).toEqual([
            {
                productId: "cs2",
                name: "Counter-Strike 2",
                kind: "module",
                features: "*",
                channels: [
                    { channel: "stable", release: null },
                    { channel: "alpha", release: { promotedAt: expect.any(Number) } },
                ],
            },
        ]);
    });
});
