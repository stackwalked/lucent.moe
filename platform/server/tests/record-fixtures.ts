import type { ModuleKey } from "@lucent/bundle/fact-set";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import type { SeededRng } from "@lucent/core/rng";
import { ChannelId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, sql } from "../src/db/pool.ts";
import { promoteFactSet } from "../src/facts/promotion.ts";
import { seedRootOnce } from "./auth-fixtures.ts";
import { catalog, product, scalar, steppedUp } from "./authority-fixtures.ts";
import { CAPABILITIES, FACTS, GAME, publishWith } from "./fact-set-fixtures.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    enroll,
    entitledMember,
    publishRelease,
    refusalCodeOf,
    signIn,
    startBody,
} from "./native-fixtures.ts";

// cs2 as a live product judged on alpha, the channel the native fixtures start on.
export function liveCatalog(): ProductCatalog {
    const products = new Map(catalog());
    const cs2 = product("cs2");
    products.set(cs2.id, {
        ...cs2,
        state: "live",
        channels: ["alpha", "stable", "debug"].map((c) => ChannelId.parse(c)),
    });
    return products;
}

export const UPDATED: ModuleKey = { ...GAME, timeDateStamp: GAME.timeDateStamp + 1 };

// A member who can start cs2 on alpha, a loader release, a cs2 release whose core capability
// needs a set for the game build, and a way to promote one for a build: the real report (a start)
// and promotion writers.
export async function supportWorld(db: Db, rng: SeededRng, products: ProductCatalog) {
    const caller = await steppedUp(db, await seedRootOnce(db, rng));
    const harness = await createNativeHarness(db, rng, { catalog: products });
    const loaderRelease = await publishRelease(db, rng, {
        product: "lucent-loader",
        channel: "stable",
    });
    const release = await publishRelease(db, rng, {
        product: "cs2",
        channel: "alpha",
        facts: FACTS,
        capabilities: CAPABILITIES,
    });
    const member = await entitledMember(harness, {
        email: "starter@lucent.test",
        channels: ["alpha"],
    });
    const loader = createTestLoader(harness, await createTestDevice(rng));
    await signIn(harness, loader, member.browserSession);
    await enroll(harness, loader, member.browserSession);
    let revision = 0;
    return {
        caller,
        harness,
        member,
        start: async (build: ModuleKey) =>
            refusalCodeOf(
                await loader.send({
                    method: "POST",
                    path: "/v1/starts",
                    body: startBody({ loaderRelease: loaderRelease.id, modules: [build] }),
                }),
            ),
        support: async (build: ModuleKey) => {
            revision += 1;
            const published = await publishWith(db, release.id, {
                keys: [0x10n, 0x20n],
                revision,
                modules: [build],
            });
            invariant(published.ok, "the set is published");
            const setId = await scalar(
                db,
                z.string(),
                sql`select distinct set_id::text as value from fact_set_build
                    where revision = ${revision}`,
            );
            const promoted = await promoteFactSet(db, { caller, releaseId: release.id, setId });
            invariant(promoted.ok, "the set is promoted");
        },
    };
}
