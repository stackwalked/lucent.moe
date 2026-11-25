import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, ProductId } from "@lucent/core/scalars";
import type { CloudRequest, CloudResponse } from "@lucent/wire/cloud";
import { parseFrame } from "@lucent/wire/frame";
import { z } from "zod";
import { CLOUD_LIMITS } from "../src/cloud/items.rules.ts";
import { createItem } from "../src/cloud/items.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { seedAccount } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    createTestModule,
    enroll,
    entitledMember,
    type Member,
    type NativeHarness,
    publishBoth,
    type Releases,
    refusalCodeOf,
    sessionPath,
    signIn,
    startBody,
    startOk,
    type TestLoader,
    type TestModule,
} from "./native-fixtures.ts";

const text = (value: string) => new TextEncoder().encode(value);

type Running = { readonly module: TestModule; readonly path: string };

type Account = {
    readonly harness: NativeHarness;
    readonly releases: Releases;
    readonly member: Member;
    readonly loader: TestLoader;
};

async function account(harness: NativeHarness, email: string): Promise<Account> {
    const releases = await publishBoth(harness.db, harness.rng);
    const member = await entitledMember(harness, { email, channels: ["alpha"] });
    const loader = createTestLoader(harness, await createTestDevice(harness.rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    return { harness, releases, member, loader };
}

// A start and its session; a later one of the same account takes the product's slot.
async function run(at: Account): Promise<Running> {
    const started = await startOk(at.loader, at.releases);
    const module = createTestModule(at.harness.rng, at.harness.signer.publicKey);
    const opened = await at.loader.send({
        method: "POST",
        path: `${started.path}/session`,
        body: await module.hello(at.releases.module.id),
    });
    invariant(opened.status === 200, `the session was refused: ${refusalCodeOf(opened)}`);
    await module.acceptSession(opened.bytes);
    return { module, path: sessionPath(module.session()) };
}

async function send(at: Account, running: Running, body: Uint8Array, operationId?: string) {
    return await at.loader.send({
        method: "POST",
        path: `${running.path}/data`,
        body,
        ...(operationId === undefined ? {} : { operationId }),
    });
}

// The request's answer, as the module opens it.
async function ask(at: Account, running: Running, request: CloudRequest): Promise<CloudResponse> {
    const sent = await send(at, running, running.module.cloudRequest(request));
    invariant(sent.status === 200, `the cloud request was refused: ${refusalCodeOf(sent)}`);
    return running.module.acceptCloud(sent.bytes);
}

function written(response: CloudResponse) {
    invariant(response.operation === "create" || response.operation === "replace", "a write");
    const { result } = response;
    invariant(result.ok, `the write was refused: ${result.ok ? "" : result.error.code}`);
    return result.value;
}

function fetched(response: CloudResponse) {
    invariant(response.operation === "fetch" && response.result.ok, "a fetch answer");
    return response.result.value;
}

function listed(response: CloudResponse) {
    invariant(response.operation === "list" && response.result.ok, "a list answer");
    return response.result.value;
}

const create = (body: Uint8Array, name = "Ranked"): CloudRequest => ({
    operation: "create",
    kind: "config",
    name,
    body,
});

const replace = (id: bigint, base: number, body: Uint8Array): CloudRequest => ({
    operation: "replace",
    id,
    base,
    body,
});

const fetchOne = (id: bigint, revision: number | null = null): CloudRequest => ({
    operation: "fetch",
    items: [{ id, revision }],
});

test("a config written over /data by one session is read by the account's next session, and a stale write keeps the loser in history", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_701));
        const at = await account(harness, "cloud@lucent.test");
        const first = await run(at);
        const config = text("[aim]\nfov = 6.5\n");
        const made = written(await ask(at, first, create(config)));
        expect(made).toEqual({ id: made.id, revision: 1, conflict: false });

        const second = await run(at);
        const stale = await send(at, first, first.module.cloudRequest({ operation: "list" }));
        expect(refusalCodeOf(stale)).toBe("SLOT_TAKEN");

        expect(listed(await ask(at, second, { operation: "list" }))).toEqual([
            { id: made.id, kind: "config", revision: 1, size: config.byteLength, name: "Ranked" },
        ]);
        expect(fetched(await ask(at, second, fetchOne(made.id)))).toEqual([
            {
                id: made.id,
                version: { revision: 1, kind: "config", name: "Ranked", body: config },
            },
        ]);

        const winner = text("[aim]\nfov = 4.0\n");
        const loser = text("[aim]\nfov = 3.0\n");
        expect(written(await ask(at, second, replace(made.id, 1, winner)))).toEqual({
            id: made.id,
            revision: 2,
            conflict: false,
        });
        const late = second.module.cloudRequest(replace(made.id, 1, loser));
        const operationId = newOperationId(harness.rng);
        const conflicting = await send(at, second, late, operationId);
        expect(written(second.module.acceptCloud(conflicting.bytes))).toEqual({
            id: made.id,
            revision: 3,
            conflict: true,
        });
        const retried = await send(at, second, late, operationId);
        expect(retried.status).toBe(200);
        expect(second.module.acceptCloud(retried.bytes)).toEqual(
            second.module.acceptCloud(conflicting.bytes),
        );
        const sequenceOf = (bytes: Uint8Array) => {
            const frame = parseFrame(bytes);
            invariant(frame.ok, "the reply is a frame");
            return frame.value.header.sequence;
        };
        expect(sequenceOf(retried.bytes)).toBe(sequenceOf(conflicting.bytes));

        // The displaced head is in history at its own revision; the retry wrote nothing.
        expect(fetched(await ask(at, second, fetchOne(made.id, 2)))).toEqual([
            {
                id: made.id,
                version: { revision: 2, kind: "config", name: "Ranked", body: winner },
            },
        ]);
        expect(fetched(await ask(at, second, fetchOne(made.id, 4)))).toEqual([
            { id: made.id, version: null },
        ]);
        expect(listed(await ask(at, second, { operation: "list" }))[0]?.revision).toBe(3);
        const revision = await queryOne(
            nativeDb,
            z.object({ dataRevision: z.string() }),
            sql`select data_revision::text as "dataRevision" from runtime_session
                where id = ${second.module.session()}`,
        );
        expect(revision).toEqual(ok({ dataRevision: "0" }));
    });
});

test("a session reaches neither another account's items nor its own account's in another product over /data", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_702));
        const at = await account(harness, "own@lucent.test");
        const running = await run(at);
        const neighbour = await seedAccount(nativeDb, harness.rng, "neighbour@lucent.test");
        const foreign = { kind: "config", name: "x", bytes: Uint8Array.of(9) } as const;
        const theirs: bigint[] = [];
        for (const scope of [
            { accountId: neighbour, productId: ProductId.parse("cs2") },
            { accountId: at.member.accountId, productId: ProductId.parse("other") },
        ]) {
            const made = await withTx(nativeDb, (tx) =>
                createItem(tx, { ...scope, ...foreign, limits: CLOUD_LIMITS }),
            );
            invariant(made.ok, "the foreign item is created");
            theirs.push(BigInt(made.value.itemId));
        }

        expect(listed(await ask(at, running, { operation: "list" }))).toEqual([]);
        expect(
            fetched(
                await ask(at, running, {
                    operation: "fetch",
                    items: theirs.map((id) => ({ id, revision: null })),
                }),
            ),
        ).toEqual(theirs.map((id) => ({ id, version: null })));
        for (const id of theirs) {
            expect((await ask(at, running, replace(id, 1, Uint8Array.of(0)))).result).toEqual(
                err({ code: "NOT_FOUND" }),
            );
        }
    });
});

test("a session write into a full history window drops the oldest version", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_703), {
            cloudLimits: { ...CLOUD_LIMITS, maxVersionsPerItem: 2 },
        });
        const at = await account(harness, "window@lucent.test");
        const running = await run(at);
        const made = written(await ask(at, running, create(Uint8Array.of(1))));
        written(await ask(at, running, replace(made.id, 1, Uint8Array.of(2))));
        expect(written(await ask(at, running, replace(made.id, 2, Uint8Array.of(3))))).toEqual({
            id: made.id,
            revision: 3,
            conflict: false,
        });

        const at1 = fetched(await ask(at, running, fetchOne(made.id, 1)));
        const at2 = fetched(await ask(at, running, fetchOne(made.id, 2)));
        expect(at1).toEqual([{ id: made.id, version: null }]);
        expect(at2[0]?.version?.body).toEqual(Uint8Array.of(2));
    });
});

test("an entitlement revoked mid-session leaves the session's cloud read and write working, and the next start is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_704));
        const at = await account(harness, "lapsed@lucent.test");
        const running = await run(at);
        const revoked = await execute(
            nativeDb,
            sql`update entitlement set status = 'revoked' where account_id = ${at.member.accountId}`,
        );
        expect(revoked).toEqual(ok(1));

        const made = written(await ask(at, running, create(Uint8Array.of(5))));
        expect(fetched(await ask(at, running, fetchOne(made.id)))[0]?.version?.body).toEqual(
            Uint8Array.of(5),
        );
        const refused = await at.loader.send({
            method: "POST",
            path: "/v1/starts",
            body: startBody({ loaderRelease: at.releases.loader.id }),
        });
        expect(refusalCodeOf(refused)).toBe("ENTITLEMENT_INACTIVE");
    });
});

test("cloud refusals the writers decide answer in the status byte, and out-of-range ids and revisions never reach the database", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_705));
        const at = await account(harness, "edges@lucent.test");
        const running = await run(at);
        const made = written(await ask(at, running, create(Uint8Array.of(1))));
        const statusOf = async (request: CloudRequest) => (await ask(at, running, request)).result;

        expect(await statusOf(replace(made.id, 2, Uint8Array.of(2)))).toEqual(
            err({ code: "INVALID_BASE" }),
        );
        expect(await statusOf(replace(made.id, 2 ** 31, Uint8Array.of(2)))).toEqual(
            err({ code: "INVALID_BASE" }),
        );
        expect(await statusOf(replace(1n << 63n, 1, Uint8Array.of(2)))).toEqual(
            err({ code: "NOT_FOUND" }),
        );
        expect(await statusOf(create(new Uint8Array(CLOUD_LIMITS.maxVersionBytes)))).toEqual(
            err({ code: "SIZE_LIMIT" }),
        );
        expect(
            await statusOf({
                operation: "fetch",
                items: [
                    { id: (1n << 64n) - 1n, revision: null },
                    { id: made.id, revision: 2 ** 32 - 1 },
                ],
            }),
        ).toEqual(
            ok([
                { id: (1n << 64n) - 1n, version: null },
                { id: made.id, version: null },
            ]),
        );
        // The site's name rule: a blank name is the transport's INVALID_REQUEST, no status.
        const blank = await send(
            at,
            running,
            running.module.cloudRequest(create(Uint8Array.of(1), "   ")),
        );
        expect(blank.status).toBe(400);
        expect(refusalCodeOf(blank)).toBe("INVALID_REQUEST");
        expect(listed(await ask(at, running, { operation: "list" }))).toHaveLength(1);
    });
});

test("a name stored longer than the wire carries is listed and fetched cut at a code point", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_706));
        const at = await account(harness, "long@lucent.test");
        const running = await run(at);
        // 64 code points, 256 bytes: what the site accepted before the byte cap.
        const name = "\u{1f3af}".repeat(64);
        const made = await withTx(nativeDb, (tx) =>
            createItem(tx, {
                accountId: at.member.accountId,
                productId: ProductId.parse("cs2"),
                kind: "script",
                name,
                bytes: Uint8Array.of(1),
                limits: CLOUD_LIMITS,
            }),
        );
        invariant(made.ok, "the item is created");

        const cut = "\u{1f3af}".repeat(63);
        expect(listed(await ask(at, running, { operation: "list" }))[0]?.name).toBe(cut);
        expect(
            fetched(await ask(at, running, fetchOne(BigInt(made.value.itemId))))[0]?.version?.name,
        ).toBe(cut);
    });
});

test("without cloud limits every cloud request answers UNAVAILABLE", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const harness = await createNativeHarness(nativeDb, createSeededRng(9_707), {
            cloudLimits: null,
        });
        const at = await account(harness, "nolimits@lucent.test");
        const running = await run(at);
        for (const request of [{ operation: "list" } as const, create(Uint8Array.of(1))]) {
            expect((await ask(at, running, request)).result).toEqual(err({ code: "UNAVAILABLE" }));
        }
    });
});
