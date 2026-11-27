import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import { toReleaseManifestV3Bytes } from "@lucent/bundle/release-manifest";
import { invariant } from "@lucent/core/contain";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { ChannelId, EpochMs, ProductId, toHex } from "@lucent/core/scalars";
import { RECENT_WINDOW_SECONDS } from "@lucent/policy/policy";
import { LOADER_DOWNLOAD_PATH } from "@lucent/rpc/web";
import { z } from "zod";
import { claimServiceEpoch, openEpochGuard } from "../src/base/db/epoch-guard.ts";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { listReleaseFactSets, promoteFactSet } from "../src/delivery/facts/promotion.ts";
import { listMemberProducts } from "../src/delivery/products/products.ts";
import { readLoaderOffer } from "../src/delivery/releases/offer.ts";
import { listReleaseLines, promoteRelease } from "../src/delivery/releases/promotion.ts";
import { findCurrentRelease } from "../src/delivery/releases/reads.ts";
import { createInternalWebApp } from "../src/edge/listeners/internal/app.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import {
    catalog,
    dbNow,
    product,
    scalar,
    seedAccount,
    seedRole,
    seedStaff,
    steppedUp,
} from "./authority-fixtures.ts";
import {
    CAPABILITIES,
    coreRelease,
    FACTS,
    GAME,
    OTHER_GAME,
    publishWith,
} from "./fact-set-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    promoteLoader,
    publishRelease,
    refusalCodeOf,
    signIn,
    startBody,
} from "./native-fixtures.ts";

const CS2 = ProductId.parse("cs2");
const ALPHA = ChannelId.parse("alpha");

// A release and its seal, staged as ops leaves them: nothing made current.
async function stage(
    db: Db,
    rng: SeededRng,
    params: { readonly product: string; readonly channel: string; readonly number: bigint },
): Promise<Uint8Array> {
    const id = rng.fillBytes(new Uint8Array(16));
    const isModule = params.product !== "lucent-loader";
    const manifest = isModule
        ? toReleaseManifestV3Bytes({
              product: params.product,
              facts: [],
              capabilities: [],
              features: [],
          })
        : null;
    const container = isModule ? rng.fillBytes(new Uint8Array(100)) : null;
    const stored = await execute(
        db,
        sql`insert into release (id, product_id, channel, container, manifest)
            values (${id}, ${params.product}, ${params.channel}, ${container}, ${manifest})`,
    );
    invariant(stored.ok, `staging the release failed: ${JSON.stringify(stored)}`);
    const sealed = await execute(
        db,
        sql`insert into release_seal (product_id, channel, number, release_id, seal)
            values (${params.product}, ${params.channel}, ${params.number}, ${id},
                    ${rng.fillBytes(new Uint8Array(96))})`,
    );
    invariant(sealed.ok, `staging the seal failed: ${JSON.stringify(sealed)}`);
    return id;
}

async function rootCaller(db: Db, rng: SeededRng) {
    return await steppedUp(db, await seedRootOnce(db, rng));
}

async function auditCount(db: Db, operation: string): Promise<number> {
    return await scalar(
        db,
        z.coerce.number(),
        sql`select count(*) as value from audit where operation = ${operation}`,
    );
}

test("promoting a staged seal makes it current, and promoting a higher one replaces it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_801);
        const caller = await rootCaller(nativeDb, rng);
        const first = await stage(nativeDb, rng, { product: "cs2", channel: "alpha", number: 1n });
        const second = await stage(nativeDb, rng, { product: "cs2", channel: "alpha", number: 2n });
        const promote = (number: string) =>
            promoteRelease(nativeDb, {
                catalog: catalog(),
                caller,
                productId: CS2,
                channel: ALPHA,
                number,
            });
        const current = async () => {
            const found = await findCurrentRelease(nativeDb, { productId: CS2, channel: ALPHA });
            invariant(found.ok && found.value !== null, "a release is current");
            return { id: toHex(found.value.id), number: found.value.number };
        };

        expect(await promote("1")).toEqual({ ok: true, value: { changed: true } });
        expect(await current()).toEqual({ id: toHex(first), number: 1n });
        expect(await promote("2")).toEqual({ ok: true, value: { changed: true } });
        expect(await current()).toEqual({ id: toHex(second), number: 2n });

        const lines = await listReleaseLines(nativeDb, { catalog: catalog(), caller });
        invariant(lines.ok, "staff list release lines");
        const alpha = lines.value.find(
            (line) => line.productId === "cs2" && line.channel === "alpha",
        );
        expect(alpha?.current?.number).toBe("2");
        // The replaced seal is below current: nothing can promote it again.
        expect(alpha?.seals.map((seal) => [seal.number, seal.releaseId])).toEqual([
            ["2", toHex(second)],
        ]);
    });
});

test("a seal numbered below the current one is refused, and the current one again changes nothing", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_802);
        const caller = await rootCaller(nativeDb, rng);
        await stage(nativeDb, rng, { product: "cs2", channel: "alpha", number: 1n });
        await stage(nativeDb, rng, { product: "cs2", channel: "alpha", number: 2n });
        const promote = (number: string, channel = ALPHA, productId = CS2) =>
            promoteRelease(nativeDb, { catalog: catalog(), caller, productId, channel, number });

        expect((await promote("2")).ok).toBe(true);
        expect(await promote("1")).toEqual({
            ok: false,
            error: { code: "SEAL_BELOW_CURRENT", current: "2" },
        });
        expect(await promote("2")).toEqual({ ok: true, value: { changed: false } });
        expect(await promote("9")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
        // The loader has one release line, on stable only.
        expect(await promote("1", ALPHA, ProductId.parse("lucent-loader"))).toEqual({
            ok: false,
            error: { code: "NOT_FOUND" },
        });
        expect(await auditCount(nativeDb, "release.promote")).toBe(1);
    });
});

test("promoting releases and fact sets needs the permission and a recent passkey step-up, and is audited", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_803);
        await seedRootOnce(nativeDb, rng);
        const roleId = await seedRole(nativeDb, {
            id: "role_release",
            rank: 10,
            permissions: ["releases:promote", "facts:promote"],
        });
        const staffId = await seedStaff(nativeDb, rng, { email: "release@lucent.test", roleId });
        const outsiderId = await seedAccount(nativeDb, rng, "outsider@lucent.test");
        await stage(nativeDb, rng, { product: "lucent-loader", channel: "stable", number: 1n });
        const promoteLoaderAs = async (caller: Awaited<ReturnType<typeof steppedUp>>) =>
            await promoteRelease(nativeDb, {
                catalog: catalog(),
                caller,
                productId: ProductId.parse("lucent-loader"),
                channel: ChannelId.parse("stable"),
                number: "1",
            });

        // Signed in eight days ago and never stepped up: the sign-in is older than the week
        // "recent" asks for. (A caller with no sign-in at all is a different refusal.)
        const stale = {
            accountId: staffId,
            stepUpAt: null,
            authenticatedAt: EpochMs.parse((await dbNow(nativeDb)) - 8 * 86_400_000),
            client: null,
        };
        expect(await promoteLoaderAs(stale)).toEqual({
            ok: false,
            error: { code: "STEP_UP_REQUIRED", withinSeconds: RECENT_WINDOW_SECONDS },
        });
        expect(await promoteLoaderAs(await steppedUp(nativeDb, outsiderId))).toEqual({
            ok: false,
            error: { code: "FORBIDDEN" },
        });
        expect(await auditCount(nativeDb, "release.promote")).toBe(0);
        expect(await promoteLoaderAs(await steppedUp(nativeDb, staffId))).toEqual({
            ok: true,
            value: { changed: true },
        });
        const audited = await queryAll(
            nativeDb,
            z.object({ actor_id: z.string(), target: z.record(z.string(), z.unknown()) }),
            sql`select actor_id, target from audit where operation = 'release.promote'`,
        );
        expect(audited.ok && audited.value).toEqual([
            {
                actor_id: staffId,
                target: expect.objectContaining({
                    productId: "lucent-loader",
                    channel: "stable",
                    number: "1",
                    previous: null,
                }),
            },
        ]);

        const release = await coreRelease(nativeDb, rng);
        expect((await publishWith(nativeDb, release.id, { keys: [0x10n, 0x20n] })).ok).toBe(true);
        const setId = await scalar(
            nativeDb,
            z.string(),
            sql`select id::text as value from fact_set`,
        );
        const promoteSet = (caller: Awaited<ReturnType<typeof steppedUp>>) =>
            promoteFactSet(nativeDb, { caller, releaseId: release.id, setId });
        expect(await promoteSet(stale)).toEqual({
            ok: false,
            error: { code: "STEP_UP_REQUIRED", withinSeconds: RECENT_WINDOW_SECONDS },
        });
        expect(await promoteSet(await steppedUp(nativeDb, outsiderId))).toEqual({
            ok: false,
            error: { code: "FORBIDDEN" },
        });
        expect(await promoteSet(await steppedUp(nativeDb, staffId))).toEqual({
            ok: true,
            value: { changed: true },
        });
        expect(await auditCount(nativeDb, "fact_set.promote")).toBe(1);
    });
});

async function currentRevisions(db: Db, release: Uint8Array): Promise<Record<string, number>> {
    const rows = await queryAll(
        db,
        z.object({ name_hash: z.string(), revision: z.coerce.number() }),
        sql`select name_hash::text as name_hash, revision from current_fact_set
            where release_id = ${release} order by name_hash`,
    );
    invariant(rows.ok, "current sets read");
    return Object.fromEntries(rows.value.map((row) => [row.name_hash, row.revision]));
}

async function setIdOf(db: Db, revision: number): Promise<string> {
    return await scalar(
        db,
        z.string(),
        sql`select distinct set_id::text as value from fact_set_build where revision = ${revision}`,
    );
}

const hashOf = (build: ModuleKey) => build.nameHash.toString();

test("promoting a fact set makes it current for every build it lists", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_804);
        const caller = await rootCaller(nativeDb, rng);
        const release = await coreRelease(nativeDb, rng);
        const keys = [0x10n, 0x20n];
        expect((await publishWith(nativeDb, release.id, { keys, revision: 1 })).ok).toBe(true);
        expect(
            (
                await publishWith(nativeDb, release.id, {
                    keys,
                    revision: 2,
                    modules: [GAME, OTHER_GAME],
                })
            ).ok,
        ).toBe(true);
        const promote = async (revision: number) =>
            await promoteFactSet(nativeDb, {
                caller,
                releaseId: release.id,
                setId: await setIdOf(nativeDb, revision),
            });

        expect(await promote(1)).toEqual({ ok: true, value: { changed: true } });
        expect(await currentRevisions(nativeDb, release.id)).toEqual({ [hashOf(GAME)]: 1 });
        expect(await promote(2)).toEqual({ ok: true, value: { changed: true } });
        expect(await currentRevisions(nativeDb, release.id)).toEqual({
            [hashOf(GAME)]: 2,
            [hashOf(OTHER_GAME)]: 2,
        });
        expect(await promote(2)).toEqual({ ok: true, value: { changed: false } });

        const listed = await listReleaseFactSets(nativeDb, { caller, releaseId: release.id });
        invariant(listed.ok, "staff list a release's fact sets");
        expect(listed.value.sets.map((set) => [set.revision, set.builds.length])).toEqual([
            [2, 2],
            [1, 1],
        ]);
        expect(listed.value.builds.map((build) => build.current?.revision)).toEqual([2, 2]);
        expect(
            await promoteFactSet(nativeDb, { caller, releaseId: release.id, setId: "999" }),
        ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    });
});

test("a fact set below the current revision of any build it lists is refused, and moves none", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_805);
        const caller = await rootCaller(nativeDb, rng);
        const release = await coreRelease(nativeDb, rng);
        const keys = [0x10n, 0x20n];
        const spanning = { keys, revision: 1, modules: [GAME, OTHER_GAME] };
        expect((await publishWith(nativeDb, release.id, spanning)).ok).toBe(true);
        const other = { keys, revision: 2, modules: [OTHER_GAME] };
        expect((await publishWith(nativeDb, release.id, other)).ok).toBe(true);
        const promote = async (revision: number) =>
            await promoteFactSet(nativeDb, {
                caller,
                releaseId: release.id,
                setId: await setIdOf(nativeDb, revision),
            });

        expect((await promote(2)).ok).toBe(true);
        expect(await promote(1)).toEqual({
            ok: false,
            error: { code: "REVISION_BELOW_CURRENT", current: 2 },
        });
        expect(await currentRevisions(nativeDb, release.id)).toEqual({ [hashOf(OTHER_GAME)]: 2 });
    });
});

test("the loader download serves the current loader's bytes to a member entitled to a product, and nothing to one without", async () => {
    const cluster = await sharedTestCluster();
    const artifactDir = await mkdtemp(join(tmpdir(), "lucent-download-"));
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_806);
        const harness = await createNativeHarness(nativeDb, rng);
        const promoted = await promoteLoader(nativeDb, rng, { number: 3n, artifactDir });
        const member = await entitledMember(harness, {
            email: "download@lucent.test",
            channels: ["alpha"],
        });
        const deps = await createTestAuthDeps(nativeDb, rng);
        const stranger = await memberSession(
            deps,
            await seedAccount(nativeDb, rng, "stranger@lucent.test"),
        );
        const claimed = await claimServiceEpoch(nativeDb);
        invariant(claimed.ok, "the epoch is claimed");
        const guard = openEpochGuard({
            db: nativeDb,
            ownEpoch: claimed.value,
            pollIntervalMs: 60_000,
            onReadFailure: () => {},
        });
        const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
        const app = createInternalWebApp({
            catalog: catalog(),
            auth: deps,
            epochGuard: guard,
            webInternalKey: peerKey,
            artifactDir,
            logger: { write: () => {} },
        });
        const download = async (session: string | null, key = peerKey) =>
            await app.fetch(
                new Request(`http://localhost${LOADER_DOWNLOAD_PATH}`, {
                    headers: {
                        authorization: `Bearer ${key}`,
                        ...(session === null ? {} : { "lucent-session": session }),
                    },
                }),
            );

        const served = await download(member.browserSession);
        expect(served.status).toBe(200);
        expect(served.headers.get("cache-control")).toBe("no-store");
        expect(served.headers.get("content-length")).toBe(String(promoted.loader.byteLength));
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(promoted.loader));
        expect(
            await readLoaderOffer(nativeDb, {
                catalog: catalog(),
                sessionToken: member.browserSession,
            }),
        ).toEqual({
            ok: true,
            value: { state: "ready", number: "3", digest: expect.any(String) },
        });

        const refused = await download(stranger);
        expect(refused.status).toBe(404);
        expect(await refused.json()).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
        expect(
            await readLoaderOffer(nativeDb, { catalog: catalog(), sessionToken: stranger }),
        ).toEqual({ ok: true, value: { state: "no_product" } });
        expect((await download(null)).status).toBe(400);
        expect((await download(member.browserSession, `${peerKey}x`)).status).toBe(401);
        for (const id of ["cs2", "lucent-loader"]) {
            const definitions = new Map(catalog());
            const original = product(id);
            definitions.set(original.id, { ...original, state: "retired" });
            expect(
                await readLoaderOffer(nativeDb, {
                    catalog: definitions,
                    sessionToken: member.browserSession,
                }),
            ).toEqual({ ok: true, value: { state: "no_product" } });
        }
        guard.close();
    });
    await rm(artifactDir, { recursive: true, force: true });
});

test("a channel is not yet supported while its current sets miss the game builds the latest start reported", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_807);
        const caller = await rootCaller(nativeDb, rng);
        const harness = await createNativeHarness(nativeDb, rng);
        const loaderRelease = await publishRelease(nativeDb, rng, {
            product: "lucent-loader",
            channel: "stable",
        });
        const release = await publishRelease(nativeDb, rng, {
            product: "cs2",
            channel: "alpha",
            facts: FACTS,
            capabilities: CAPABILITIES,
        });
        const member = await entitledMember(harness, {
            email: "coverage@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        await signIn(harness, loader, member.browserSession);
        await enroll(harness, loader, member.browserSession);
        const supported = async () => {
            const listed = await listMemberProducts(nativeDb, {
                catalog: harness.catalog,
                sessionToken: member.browserSession,
            });
            invariant(listed.ok, "web lists products");
            return listed.value[0]?.channels[0]?.release?.supported;
        };
        const start = async (build: ModuleKey) =>
            refusalCodeOf(
                await loader.send({
                    method: "POST",
                    path: "/v1/starts",
                    body: startBody({ loaderRelease: loaderRelease.id, modules: [build] }),
                }),
            );
        let revision = 0;
        const support = async (build: ModuleKey) => {
            revision += 1;
            const published = await publishWith(nativeDb, release.id, {
                keys: [0x10n, 0x20n],
                revision,
                modules: [build],
            });
            invariant(published.ok, "the set is published");
            const promoted = await promoteFactSet(nativeDb, {
                caller,
                releaseId: release.id,
                setId: await setIdOf(nativeDb, revision),
            });
            invariant(promoted.ok, "the set is promoted");
        };

        // Before any start, the builds the current sets list.
        await support(GAME);
        expect(await supported()).toBe(true);
        expect(await start(GAME)).toBe("NOT_A_REFUSAL");
        expect(await supported()).toBe(true);

        // The game updates: the start brings a build no set covers, is refused, and the page
        // follows it until a set for the new build is promoted.
        const updated = { ...GAME, timeDateStamp: GAME.timeDateStamp + 1 };
        expect(await start(updated)).toBe("GAME_BUILD_UNSUPPORTED");
        expect(await supported()).toBe(false);
        await support(updated);
        expect(await supported()).toBe(true);
        expect(await start(updated)).toBe("NOT_A_REFUSAL");
    });
});
