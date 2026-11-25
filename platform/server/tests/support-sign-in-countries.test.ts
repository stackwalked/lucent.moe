import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, ClientInfo } from "@lucent/core/scalars";
import { z } from "zod";
import { parseCountryDatabase } from "../src/adapters/geo/geo.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { listReviewItems } from "../src/risk/review.ts";
import { scoreRisk } from "../src/risk/scoring.ts";
import { appendSignals } from "../src/risk/signals.ts";
import { judgeSignInCountries } from "../src/support/sign-in-countries.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { scalar, seedAccount, steppedUp } from "./authority-fixtures.ts";
import { countryDatabase } from "./geo-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const FILE = parseCountryDatabase(
    countryDatabase([
        { cidr: "2.0.0.0/8", country: "FR" },
        { cidr: "203.0.113.0/24", country: "JP" },
    ]),
);

async function signInFrom(deps: AuthDeps, accountId: AccountId, ip: string) {
    await memberSession(deps, accountId, ClientInfo.parse({ ip, userAgent: "test" }));
}

test("a sign-in from a new country is recorded and opens a review item only beside another signal; the first country and known ones don't", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        invariant(FILE.ok, "the test file parses");
        const rng = createSeededRng(821);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await seedAccount(browserDb, rng, "alice@lucent.test");
        const bob = await seedAccount(browserDb, rng, "bob@lucent.test");

        await signInFrom(deps, alice, "2.1.1.1");
        await signInFrom(deps, alice, "2.9.9.9");
        await signInFrom(deps, bob, "2.1.1.1");
        await signInFrom(deps, bob, "10.0.0.1");
        expect(await judgeSignInCountries(browserDb, FILE.value)).toEqual(
            ok({ judged: 4, flagged: 0 }),
        );

        await signInFrom(deps, alice, "203.0.113.7");
        expect(await judgeSignInCountries(browserDb, FILE.value)).toEqual(
            ok({ judged: 1, flagged: 1 }),
        );
        expect(
            await scalar(
                browserDb,
                z.coerce.number(),
                sql`select count(*) as value from sign_in_observation`,
            ),
        ).toBe(0);

        const signalsOf = (accountId: AccountId) =>
            scalar(
                browserDb,
                z.coerce.number(),
                sql`select count(*) as value from risk_signal
                    where account_id = ${accountId} and kind = 'new_country'`,
            );
        expect(await signalsOf(alice)).toBe(1);
        expect((await scoreRisk(browserDb)).ok).toBe(true);
        const root = await steppedUp(browserDb, await seedRootOnce(browserDb, rng));
        const openItems = async () => {
            const queue = await listReviewItems(browserDb, { caller: root, state: "open" });
            invariant(queue.ok, "root reads the queue");
            return queue.value.items;
        };
        expect(await openItems()).toEqual([]);

        // A silent session alone is under the threshold too; together they are over it.
        await signInFrom(deps, bob, "2.5.5.5");
        await signInFrom(deps, bob, "203.0.113.8");
        await withTx(browserDb, (tx, txNow) =>
            appendSignals(tx, {
                accountId: bob,
                releaseId: null,
                sessionId: null,
                kinds: ["loader_silent"],
                at: txNow,
            }),
        );
        expect(await judgeSignInCountries(browserDb, FILE.value)).toEqual(
            ok({ judged: 2, flagged: 1 }),
        );
        expect((await scoreRisk(browserDb)).ok).toBe(true);
        const items = await openItems();
        expect(items.map((item) => item.account.id)).toEqual([bob]);
        expect(items[0]?.signals.map((signal) => signal.kind)).toEqual([
            "loader_silent",
            "new_country",
        ]);
    });
});

test("without a country file, sign-ins wait a day to be judged and are then dropped unjudged", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(822);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await seedAccount(browserDb, rng, "alice@lucent.test");
        await signInFrom(deps, alice, "2.1.1.1");
        await signInFrom(deps, alice, "203.0.113.7");
        await scalar(
            browserDb,
            z.coerce.number(),
            sql`with aged as (
                    update sign_in_observation set observed_at = now() - interval '25 hours'
                    where id = (select min(id) from sign_in_observation) returning 1)
                select count(*) as value from aged`,
        );
        expect(await judgeSignInCountries(browserDb, null)).toEqual(ok({ judged: 0, flagged: 0 }));
        expect(
            await scalar(
                browserDb,
                z.coerce.number(),
                sql`select count(*) as value from sign_in_observation`,
            ),
        ).toBe(1);
        expect(
            await scalar(
                browserDb,
                z.coerce.number(),
                sql`select count(*) as value from risk_signal`,
            ),
        ).toBe(0);
    });
});
