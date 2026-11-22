import { expect, test } from "bun:test";
import type { ModuleKey } from "@lucent/bundle/fact-set";
import {
    type LocatedFact,
    type ManifestCapability,
    manifestDigest,
} from "@lucent/bundle/release-manifest";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { queryAll, sql } from "../src/db/pool.ts";
import { publishFactSet } from "../src/native/fact-sets.ts";
import {
    CAPABILITIES,
    coreRelease,
    FACTS,
    FACTS_KEY,
    factSetBytes,
    GAME,
    OTHER_GAME,
    OTHER_SEED,
    promote,
    publishWith,
} from "./fact-set-fixtures.ts";
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
