import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import {
    linkDiscordAccount,
    readDiscordLink,
    removeDiscordLinkBySite,
    removeDiscordLinkByUser,
} from "../src/edge/discord/links.ts";
import { memberSession } from "./auth-fixtures.ts";
import { seedAccount, waitForLockWaiters } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const ALICE = "200000000000000001";
const BOB = "200000000000000002";
const CAROL = "200000000000000003";

const as = (userId: string) => ({ userId, username: `user${userId.slice(-3)}` });

async function links(db: Db) {
    const rows = await queryAll(
        db,
        z.object({ account_id: z.string(), discord_user_id: z.string() }),
        sql`select account_id, discord_user_id from connector_discord_link order by account_id`,
    );
    invariant(rows.ok, "links readable");
    return rows.value;
}

test("an account links a Discord user once, with an audit row, and is refused when either side already has a link", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1001);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const first = await seedAccount(nativeDb, rng, "first@lucent.test");
        const second = await seedAccount(nativeDb, rng, "second@lucent.test");
        const token = await memberSession(deps, first);

        expect(
            await linkDiscordAccount(nativeDb, { token, identity: as(ALICE), client: null }),
        ).toEqual(ok(undefined));
        const read = await readDiscordLink(nativeDb, token);
        expect(read.ok && read.value.linkedAt !== null).toBe(true);
        // The account has a link already; the Discord user has one too.
        expect(
            await linkDiscordAccount(nativeDb, { token, identity: as(BOB), client: null }),
        ).toEqual(err({ code: "ALREADY_LINKED" }));
        expect(
            await linkDiscordAccount(nativeDb, {
                token: await memberSession(deps, second),
                identity: as(ALICE),
                client: null,
            }),
        ).toEqual(err({ code: "ALREADY_LINKED" }));

        expect(await links(nativeDb)).toEqual([{ account_id: first, discord_user_id: ALICE }]);
        expect(
            await queryAll(
                nativeDb,
                z.object({ actor: z.string(), account: z.string(), user: z.string() }),
                sql`select actor_id as actor, target ->> 'accountId' as account,
                           target ->> 'discordUserId' as "user"
                    from audit where operation = 'discord.link'`,
            ),
        ).toEqual(ok([{ actor: first, account: first, user: ALICE }]));
    });
});

test("two accounts linking one Discord user at once link it once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1002);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const holding = await seedAccount(nativeDb, rng, "holding@lucent.test");
        const racing = await seedAccount(nativeDb, rng, "racing@lucent.test");
        const token = await memberSession(deps, racing);

        // Another account's link to the same Discord user, written and not yet committed: the
        // racing account reads no link, then waits on the unique index for the insert.
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held = (): void => {};
        const inserted = new Promise<void>((resolve) => {
            held = resolve;
        });
        const holder = withTx(nativeDb, async (tx) => {
            const linked = await execute(
                tx,
                sql`insert into connector_discord_link (account_id, discord_user_id, linked_at)
                    values (${holding}, ${ALICE}, now())`,
            );
            held();
            await gate;
            return linked;
        });
        await inserted;
        const linking = linkDiscordAccount(nativeDb, {
            token,
            identity: as(ALICE),
            client: null,
        });
        const parked = await waitForLockWaiters(nativeDb, 1);
        release();
        await holder;
        expect(parked).toBe(true);
        expect(await linking).toEqual(err({ code: "ALREADY_LINKED" }));
        expect(await links(nativeDb)).toEqual([{ account_id: holding, discord_user_id: ALICE }]);
    });
});

test("unlinking from either side removes the link and records the Discord user", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1003);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const viaDiscord = await seedAccount(nativeDb, rng, "one@lucent.test");
        const viaSite = await seedAccount(nativeDb, rng, "two@lucent.test");
        const siteToken = await memberSession(deps, viaSite);
        for (const [accountId, userId] of [
            [viaDiscord, ALICE],
            [viaSite, CAROL],
        ] as const) {
            const linked = await linkDiscordAccount(nativeDb, {
                token: await memberSession(deps, accountId),
                identity: as(userId),
                client: null,
            });
            expect(linked.ok).toBe(true);
        }

        expect(await removeDiscordLinkByUser(nativeDb, { userId: ALICE })).toEqual(
            ok({ removed: true }),
        );
        expect(await removeDiscordLinkByUser(nativeDb, { userId: ALICE })).toEqual(
            ok({ removed: false }),
        );
        expect(await removeDiscordLinkBySite(nativeDb, { token: siteToken, client: null })).toEqual(
            ok(undefined),
        );
        expect(await links(nativeDb)).toEqual([]);

        const audited = await queryAll(
            nativeDb,
            z.object({ operation: z.string(), user: z.string(), via: z.string().nullable() }),
            sql`select operation, target ->> 'discordUserId' as user, target ->> 'via' as via
                from audit where operation like 'discord.%' order by id`,
        );
        expect(audited).toEqual(
            ok([
                { operation: "discord.link", user: ALICE, via: null },
                { operation: "discord.link", user: CAROL, via: null },
                { operation: "discord.unlink", user: ALICE, via: "discord" },
                { operation: "discord.unlink", user: CAROL, via: "site" },
            ]),
        );
    });
});
