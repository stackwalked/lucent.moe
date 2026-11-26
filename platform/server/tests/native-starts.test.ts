import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, newSessionId } from "@lucent/core/scalars";
import { CONTAINER_CHUNK_SIZE } from "@lucent/wire/container-stream";
import { parseStartReply } from "@lucent/wire/start";
import { execute, sql } from "../src/base/db/pool.ts";
import { catalog, product } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    decryptContainer,
    enroll,
    entitledMember,
    type NativeHarness,
    publishBoth,
    publishRelease,
    refusalCodeOf,
    signIn,
    startBody,
    startOk,
    type TestLoader,
} from "./native-fixtures.ts";

async function enrolledLoader(
    harness: NativeHarness,
    params: { readonly email: string; readonly channels: readonly string[] },
): Promise<{ readonly loader: TestLoader; readonly accountId: string }> {
    const member = await entitledMember(harness, params);
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    return { loader, accountId: member.accountId };
}

test("a start passes every check and returns the release seal and a fresh container key", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_201);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const { loader } = await enrolledLoader(harness, {
            email: "go@lucent.test",
            channels: ["alpha"],
        });
        const body = startBody({ loaderRelease: releases.loader.id });

        const operationId = newOperationId(rng);
        const sent = await loader.send({ method: "POST", path: "/v1/starts", body, operationId });
        const reply = parseStartReply(sent.bytes);
        invariant(reply.ok, `the start was refused: ${refusalCodeOf(sent)}`);
        expect(reply.value.releaseSeal).toEqual(releases.module.seal);

        // A retry of the same operation gets the same start; a new one, a new start and key.
        const retried = parseStartReply(
            (await loader.send({ method: "POST", path: "/v1/starts", body, operationId })).bytes,
        );
        expect(retried.ok && retried.value).toEqual(reply.value);
        const another = parseStartReply(
            (await loader.send({ method: "POST", path: "/v1/starts", body })).bytes,
        );
        invariant(another.ok, "a second start is allowed");
        expect(another.value.start).not.toEqual(reply.value.start);
        expect(another.value.containerKey).not.toEqual(reply.value.containerKey);
        expect(
            refusalCodeOf(
                await loader.send({
                    method: "POST",
                    path: "/v1/starts",
                    body: startBody({ loaderRelease: releases.loader.id, channel: "stable" }),
                    operationId,
                }),
            ),
        ).toBe("IDEMPOTENCY_CONFLICT");
    });
});

test("each start check refuses with its own reason", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_202);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const { loader, accountId } = await enrolledLoader(harness, {
            email: "checks@lucent.test",
            channels: ["alpha"],
        });
        const start = async (params: Parameters<typeof startBody>[0]) =>
            refusalCodeOf(
                await loader.send({ method: "POST", path: "/v1/starts", body: startBody(params) }),
            );

        expect(await start({ loaderRelease: releases.loader.id, channel: "stable" })).toBe(
            "CHANNEL_NOT_ALLOWED",
        );
        expect(await start({ loaderRelease: releases.loader.id, product: "valorant" })).toBe(
            "NOT_FOUND",
        );
        expect(await start({ loaderRelease: rng.fillBytes(new Uint8Array(16)) })).toBe(
            "LOADER_UPDATE_REQUIRED",
        );
        await execute(nativeDb, sql`delete from current_release where product_id = 'cs2'`);
        expect(await start({ loaderRelease: releases.loader.id })).toBe("RELEASE_UNAVAILABLE");
        await publishRelease(nativeDb, rng, { product: "cs2", channel: "alpha" });

        await execute(nativeDb, sql`update entitlement set status = 'suspended'`);
        expect(await start({ loaderRelease: releases.loader.id })).toBe("ENTITLEMENT_INACTIVE");
        await execute(nativeDb, sql`update entitlement set status = 'active'`);

        await execute(nativeDb, sql`update device set revoked_at = now()`);
        expect(await start({ loaderRelease: releases.loader.id })).toBe("DEVICE_REVOKED");
        await execute(nativeDb, sql`update device set revoked_at = null`);

        await execute(
            nativeDb,
            sql`update account set status = 'suspended' where id = ${accountId}`,
        );
        expect(await start({ loaderRelease: releases.loader.id })).toBe("ACCOUNT_SUSPENDED");
    });
});

test("a lifecycle change refuses fresh and replayed starts without a new wire code", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9303);
        const products = new Map(catalog());
        const harness = await createNativeHarness(nativeDb, rng, { catalog: products });
        const releases = await publishBoth(nativeDb, rng);
        const { loader } = await enrolledLoader(harness, {
            email: "state@lucent.test",
            channels: ["alpha"],
        });
        const cs2 = product("cs2");
        const body = startBody({ loaderRelease: releases.loader.id });
        const operationId = newOperationId(rng);
        const replay = () => loader.send({ method: "POST", path: "/v1/starts", body, operationId });
        expect(parseStartReply((await replay()).bytes).ok).toBe(true);
        const started = await startOk(loader, releases);
        for (const [state, code] of [
            ["announced", "NOT_FOUND"],
            ["retired", "RELEASE_UNAVAILABLE"],
        ] as const) {
            products.set(cs2.id, { ...cs2, state });
            expect(refusalCodeOf(await replay())).toBe(code);
            expect(
                refusalCodeOf(
                    await loader.send({ method: "GET", path: `${started.path}/container` }),
                ),
            ).toBe("START_EXPIRED");
            expect(
                refusalCodeOf(await loader.send({ method: "POST", path: "/v1/starts", body })),
            ).toBe(code);
        }
        const module = createTestModule(rng, harness.signer.publicKey);
        expect(
            refusalCodeOf(
                await loader.send({
                    method: "POST",
                    path: `${started.path}/session`,
                    body: await module.hello(releases.module.id),
                }),
            ),
        ).toBe("START_EXPIRED");
    });
});

test("a PC that never enrolled is refused a start", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_203);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "new-pc@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        await signIn(harness, loader, member.browserSession);
        const sent = await loader.send({
            method: "POST",
            path: "/v1/starts",
            body: startBody({ loaderRelease: releases.loader.id }),
        });
        expect(refusalCodeOf(sent)).toBe("DEVICE_REVOKED");
    });
});

test("the start's container arrives in 64 KiB chunks only its key opens, and a cut stream fails", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_204);
        const harness = await createNativeHarness(nativeDb, rng);
        const container = rng.fillBytes(new Uint8Array(CONTAINER_CHUNK_SIZE * 2 + 123));
        const loaderRelease = await publishRelease(nativeDb, rng, {
            product: "lucent-loader",
            channel: "stable",
        });
        const moduleRelease = await publishRelease(nativeDb, rng, {
            product: "cs2",
            channel: "alpha",
            container,
        });
        const { loader } = await enrolledLoader(harness, {
            email: "box@lucent.test",
            channels: ["alpha"],
        });
        const started = await startOk(loader, { loader: loaderRelease, module: moduleRelease });

        const downloaded = await loader.send({ method: "GET", path: `${started.path}/container` });
        expect(downloaded.status).toBe(200);
        expect(downloaded.bytes.byteLength).toBe(container.byteLength + 3 * 40);
        expect(decryptContainer(started.containerKey, downloaded.bytes)).toEqual(container);
        expect(decryptContainer(rng.fillBytes(new Uint8Array(32)), downloaded.bytes)).toBeNull();
        const cut = downloaded.bytes.subarray(0, CONTAINER_CHUNK_SIZE * 2 + 2 * 40);
        expect(decryptContainer(started.containerKey, cut)).toBeNull();
    });
});

test("an unused start expires after a minute and its session is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_205);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const { loader } = await enrolledLoader(harness, {
            email: "slow@lucent.test",
            channels: ["alpha"],
        });
        const started = await startOk(loader, releases);
        await execute(nativeDb, sql`update session_start set expires_at = now() - interval '1 ms'`);

        const module = createTestModule(rng, harness.signer.publicKey);
        const session = await loader.send({
            method: "POST",
            path: `${started.path}/session`,
            body: await module.hello(releases.module.id),
        });
        expect(refusalCodeOf(session)).toBe("START_EXPIRED");
        expect(
            refusalCodeOf(await loader.send({ method: "GET", path: `${started.path}/container` })),
        ).toBe("START_EXPIRED");
    });
});

test("a hello for another release than the start's is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_206);
        const harness = await createNativeHarness(nativeDb, rng);
        const releases = await publishBoth(nativeDb, rng);
        const { loader } = await enrolledLoader(harness, {
            email: "mix@lucent.test",
            channels: ["alpha"],
        });
        const started = await startOk(loader, releases);
        const module = createTestModule(rng, harness.signer.publicKey);
        const session = await loader.send({
            method: "POST",
            path: `${started.path}/session`,
            body: await module.hello(rng.fillBytes(new Uint8Array(16))),
        });
        expect(refusalCodeOf(session)).toBe("START_MISMATCH");
        // Not a wire id at all: no such start.
        const unknown = await loader.send({
            method: "POST",
            path: `/v1/starts/${newSessionId(rng)}/session`,
            body: await module.hello(releases.module.id),
        });
        expect(refusalCodeOf(unknown)).toBe("NOT_FOUND");
    });
});
