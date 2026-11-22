import { expect, test } from "bun:test";
import { deliverAll, toBundleBytes } from "@lucent/bundle/bundle";
import {
    type FactSetHeader,
    fromLiteral,
    type ModuleKey,
    toSignedBytes,
} from "@lucent/bundle/fact-set";
import { leafHash, treeRoot } from "@lucent/bundle/merkle";
import {
    type LocatedFact,
    type ManifestCapability,
    manifestDigest,
} from "@lucent/bundle/release-manifest";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { signWithSeed } from "@lucent/wire/session-crypto";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/db/pool.ts";
import { publishFactSet } from "../src/native/fact-sets.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    publishBoth,
    publishRelease,
    refusalCodeOf,
    signIn,
    startBody,
} from "./native-fixtures.ts";

// The facts key is a test key (RFC 8032's first); the release links three facts, the first two
// needed by a core capability and the third by an optional one.

const FACTS_SEED = Uint8Array.fromHex(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
);
const FACTS_KEY = Uint8Array.fromHex(
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
);
const OTHER_SEED = Uint8Array.fromHex(
    "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
);

// All in GAME's module.
const FACTS: readonly LocatedFact[] = [
    { key: 0x10n, kind: 1, module: 0x1234n },
    { key: 0x20n, kind: 1, module: 0x1234n },
    { key: 0x30n, kind: 1, module: 0x1234n },
];
const CAPABILITIES: readonly ManifestCapability[] = [
    { key: 0xa0n, level: "core", members: [0x10n, 0x20n] },
    { key: 0xb0n, level: "optional", members: [0x30n] },
];

// The module build startBody reports.
const GAME: ModuleKey = { nameHash: 0x1234n, timeDateStamp: 0x5566_7788, sizeOfImage: 0x0040_0000 };
const OTHER_GAME: ModuleKey = { nameHash: 0x9999n, timeDateStamp: 1, sizeOfImage: 2 };

async function factSetBytes(params: {
    readonly keys: readonly bigint[];
    readonly revision?: number;
    readonly modules?: readonly ModuleKey[];
    readonly digest?: Uint8Array;
    readonly seed?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
    const entries = params.keys.map((key) => fromLiteral(key, key + 1n));
    const unsigned: FactSetHeader = {
        game: 1,
        revision: params.revision ?? 1,
        modules: params.modules ?? [GAME],
        findersCommit: new Uint8Array(20).fill(0xc0),
        manifestDigest: params.digest ?? manifestDigest(FACTS),
        entryCount: entries.length,
        merkleRoot: treeRoot(entries.map(leafHash)),
        signature: new Uint8Array(64),
    };
    const signature = await signWithSeed(params.seed ?? FACTS_SEED, toSignedBytes(unsigned));
    return toBundleBytes([deliverAll({ header: { ...unsigned, signature }, entries })]);
}

async function publishWith(
    db: Db,
    release: Uint8Array,
    params: Parameters<typeof factSetBytes>[0],
) {
    return await publishFactSet(db, {
        factsKeys: [FACTS_KEY],
        releaseId: release,
        bundle: await factSetBytes(params),
    });
}

async function coreRelease(db: Db, rng: ReturnType<typeof createSeededRng>) {
    return await publishRelease(db, rng, {
        product: "cs2",
        channel: "alpha",
        facts: FACTS,
        capabilities: CAPABILITIES,
    });
}

async function promote(db: Db, release: Uint8Array, build: ModuleKey, revision: number) {
    const promoted = await execute(
        db,
        sql`insert into current_fact_set
                (release_id, name_hash, time_date_stamp, size_of_image, revision)
            values (${release}, ${build.nameHash.toString()}::numeric, ${build.timeDateStamp},
                    ${build.sizeOfImage}, ${revision})
            on conflict (release_id, name_hash, time_date_stamp, size_of_image)
            do update set revision = excluded.revision`,
    );
    invariant(promoted.ok, `promoting the fact set failed: ${JSON.stringify(promoted)}`);
}

test("a fact set signed for the release and carrying every core fact is stored as published, staged", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_401));
        const bundle = await factSetBytes({ keys: [0x10n, 0x20n] });

        const published = await publishFactSet(nativeDb, {
            factsKeys: [FACTS_KEY],
            releaseId: release.id,
            bundle,
        });

        expect(published).toEqual({
            ok: true,
            value: { release: release.id, revision: 1, modules: [GAME] },
        });
        const stored = await queryAll(
            nativeDb,
            z.object({ bundle: z.instanceof(Uint8Array), revision: z.coerce.number() }),
            sql`select s.bundle, b.revision from fact_set s join fact_set_build b on b.set_id = s.id`,
        );
        expect(stored.ok && stored.value).toEqual([{ bundle, revision: 1 }]);
        const promoted = await queryAll(
            nativeDb,
            z.object({ n: z.coerce.number() }),
            sql`select count(*) as n from current_fact_set`,
        );
        expect(promoted).toEqual({ ok: true, value: [{ n: 0 }] });
    });
});

test("a fact set another key signed is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_402));

        const published = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x20n],
            seed: OTHER_SEED,
        });

        expect(published).toEqual({ ok: false, error: { code: "FACT_SET_UNSIGNED" } });
    });
});

test("a fact set signed for another manifest digest is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_403));

        const published = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x20n],
            digest: manifestDigest(FACTS.slice(1)),
        });

        expect(published).toEqual({ ok: false, error: { code: "MANIFEST_DIGEST_MISMATCH" } });
    });
});

test("a fact set missing a fact a core capability needs is refused, one missing only an optional fact is not", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_404));

        const missingCore = await publishWith(nativeDb, release.id, { keys: [0x10n, 0x30n] });
        const missingOptional = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x20n],
        });

        expect(missingCore).toEqual({
            ok: false,
            error: { code: "CORE_FACT_MISSING", key: "0000000000000020" },
        });
        expect(missingOptional.ok).toBe(true);
    });
});

test("a fact set naming no stored release, or only part of a set, is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_405));
        const bundle = await factSetBytes({ keys: [0x10n, 0x20n] });

        const unknown = await publishFactSet(nativeDb, {
            factsKeys: [FACTS_KEY],
            releaseId: new Uint8Array(16).fill(0xee),
            bundle,
        });
        const garbage = await publishFactSet(nativeDb, {
            factsKeys: [FACTS_KEY],
            releaseId: release.id,
            bundle: bundle.subarray(0, bundle.byteLength - 1),
        });

        expect(unknown).toEqual({ ok: false, error: { code: "RELEASE_NOT_FOUND" } });
        expect(garbage).toEqual({ ok: false, error: { code: "FACT_SET_INVALID" } });
    });
});

test("a revision at or below the highest stored for the release and any module build it lists is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_406));
        const keys = [0x10n, 0x20n];

        expect((await publishWith(nativeDb, release.id, { keys, revision: 5 })).ok).toBe(true);
        const same = await publishWith(nativeDb, release.id, { keys, revision: 5 });
        const lower = await publishWith(nativeDb, release.id, { keys, revision: 4 });
        // A set spanning two builds is held to the revision of the one it shares.
        const composite = await publishWith(nativeDb, release.id, {
            keys,
            revision: 5,
            modules: [GAME, OTHER_GAME],
        });
        const otherBuild = await publishWith(nativeDb, release.id, {
            keys,
            revision: 1,
            modules: [OTHER_GAME],
        });
        const higher = await publishWith(nativeDb, release.id, { keys, revision: 6 });

        for (const refused of [same, lower, composite]) {
            expect(refused).toEqual({
                ok: false,
                error: { code: "REVISION_NOT_ABOVE", highest: 5 },
            });
        }
        expect(otherBuild.ok).toBe(true);
        expect(higher.ok).toBe(true);
    });
});

async function startOutcome(params: {
    readonly sets: readonly {
        readonly keys: readonly bigint[];
        readonly modules?: readonly ModuleKey[];
        readonly promote?: boolean;
    }[];
    readonly facts?: readonly LocatedFact[];
    readonly capabilities?: readonly ManifestCapability[];
}): Promise<string> {
    const cluster = await sharedTestCluster();
    let outcome = "";
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_407);
        const harness = await createNativeHarness(nativeDb, rng);
        const loaderRelease = (await publishBoth(nativeDb, rng)).loader;
        const facts = params.facts ?? FACTS;
        const release = await publishRelease(nativeDb, rng, {
            product: "cs2",
            channel: "alpha",
            facts,
            capabilities: params.capabilities ?? CAPABILITIES,
        });
        let revision = 0;
        for (const set of params.sets) {
            revision += 1;
            const modules = set.modules ?? [GAME];
            const published = await publishWith(nativeDb, release.id, {
                keys: set.keys,
                revision,
                modules,
                digest: manifestDigest(facts),
            });
            invariant(
                published.ok,
                `publishing failed: ${published.ok ? "" : published.error.code}`,
            );
            if (set.promote !== false) {
                for (const build of modules) await promote(nativeDb, release.id, build, revision);
            }
        }
        const member = await entitledMember(harness, {
            email: "cover@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(harness.rng));
        await signIn(harness, loader, member.browserSession);
        await enroll(harness, loader, member.browserSession);
        outcome = refusalCodeOf(
            await loader.send({
                method: "POST",
                path: "/v1/starts",
                body: startBody({ loaderRelease: loaderRelease.id }),
            }),
        );
    });
    return outcome;
}

// A start that succeeds has a reply, not a refusal.
const STARTED = "NOT_A_REFUSAL";

test("a start whose reported build has a current set holding every core fact passes", async () => {
    expect(await startOutcome({ sets: [{ keys: [0x10n, 0x20n] }] })).toBe(STARTED);
});

test("a set counts only when every build it lists was reported", async () => {
    const outcome = await startOutcome({
        sets: [{ keys: [0x10n, 0x20n], modules: [GAME, OTHER_GAME] }],
    });
    expect(outcome).toBe("GAME_BUILD_UNSUPPORTED");
});

test("a start with a core capability no current set covers is a game build unsupported", async () => {
    expect(await startOutcome({ sets: [] })).toBe("GAME_BUILD_UNSUPPORTED");
    expect(await startOutcome({ sets: [{ keys: [0x10n, 0x20n], promote: false }] })).toBe(
        "GAME_BUILD_UNSUPPORTED",
    );
    expect(await startOutcome({ sets: [{ keys: [0x10n, 0x20n], modules: [OTHER_GAME] }] })).toBe(
        "GAME_BUILD_UNSUPPORTED",
    );
});

test("a start with only optional capabilities uncovered passes", async () => {
    // 0x30 is in no set.
    expect(await startOutcome({ sets: [{ keys: [0x10n, 0x20n] }] })).toBe(STARTED);
    expect(
        await startOutcome({
            sets: [],
            capabilities: [{ key: 0xb0n, level: "optional", members: [0x30n] }],
        }),
    ).toBe(STARTED);
});

// Two game modules: GAME's facts feed one core capability, OTHER_GAME's another.
const SPLIT_FACTS: readonly LocatedFact[] = [
    { key: 0x10n, kind: 1, module: 0x1234n },
    { key: 0x20n, kind: 1, module: 0x1234n },
    { key: 0x40n, kind: 1, module: 0x9999n },
];
const SPLIT_CAPABILITIES: readonly ManifestCapability[] = [
    { key: 0xa0n, level: "core", members: [0x10n, 0x20n] },
    { key: 0xc0n, level: "core", members: [0x40n] },
];

test("a start whose core capability lives in a module it didn't report passes", async () => {
    const outcome = await startOutcome({
        facts: SPLIT_FACTS,
        capabilities: SPLIT_CAPABILITIES,
        sets: [{ keys: [0x10n, 0x20n] }],
    });
    expect(outcome).toBe(STARTED);
});

test("a start whose core capability's module is reported but uncovered is a game build unsupported", async () => {
    const outcome = await startOutcome({
        facts: SPLIT_FACTS,
        capabilities: SPLIT_CAPABILITIES,
        sets: [],
    });
    expect(outcome).toBe("GAME_BUILD_UNSUPPORTED");
});

test("a set missing a core fact of another module is published", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await publishRelease(nativeDb, createSeededRng(9_408), {
            product: "cs2",
            channel: "alpha",
            facts: SPLIT_FACTS,
            capabilities: SPLIT_CAPABILITIES,
        });

        const published = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x20n],
            digest: manifestDigest(SPLIT_FACTS),
        });

        expect(published.ok).toBe(true);
    });
});

test("a set missing a core fact of a module it lists is refused", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await publishRelease(nativeDb, createSeededRng(9_409), {
            product: "cs2",
            channel: "alpha",
            facts: SPLIT_FACTS,
            capabilities: SPLIT_CAPABILITIES,
        });

        const spanning = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x40n],
            modules: [GAME, OTHER_GAME],
            digest: manifestDigest(SPLIT_FACTS),
        });
        const ownModule = await publishWith(nativeDb, release.id, {
            keys: [0x10n, 0x40n],
            digest: manifestDigest(SPLIT_FACTS),
        });

        const refusal = {
            ok: false as const,
            error: { code: "CORE_FACT_MISSING" as const, key: "0000000000000020" },
        };
        expect(spanning).toEqual(refusal);
        expect(ownModule).toEqual(refusal);
    });
});

test("a fact set over 512 KiB is refused at publish", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const release = await coreRelease(nativeDb, createSeededRng(9_410));

        const published = await publishFactSet(nativeDb, {
            factsKeys: [FACTS_KEY],
            releaseId: release.id,
            bundle: new Uint8Array(512 * 1024 + 1),
        });

        expect(published).toEqual({ ok: false, error: { code: "FACT_SET_TOO_LARGE" } });
    });
});
