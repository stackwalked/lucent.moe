import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import {
    readDiscordLink,
    redeemLinkCode,
    removeDiscordLinkBySite,
    removeDiscordLinkByUser,
    startDiscordLink,
} from "../src/edge/discord/links.ts";
import type { AuthDeps } from "../src/identity/auth/deps.ts";
import { memberSession } from "./auth-fixtures.ts";
import { seedAccount, waitForLockWaiters } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const ALICE = "200000000000000001";
const BOB = "200000000000000002";
const CAROL = "200000000000000003";

async function issued(deps: AuthDeps, accountId: AccountId) {
    const token = await memberSession(deps, accountId);
    const started = await startDiscordLink(deps.db, { token, rng: deps.rng });
    invariant(started.ok, `no code: ${JSON.stringify(started)}`);
    return { token, code: started.value.code };
}

async function links(db: Db) {
    const rows = await queryAll(
        db,
        z.object({ account_id: z.string(), discord_user_id: z.string() }),
        sql`select account_id, discord_user_id from connector_discord_link order by account_id`,
    );
    invariant(rows.ok, "links readable");
    return rows.value;
}

test("a code links once, and is refused used, expired or for a Discord user already linked", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1001);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const first = await seedAccount(nativeDb, rng, "first@lucent.test");
        const second = await seedAccount(nativeDb, rng, "second@lucent.test");

        const { token, code } = await issued(deps, first);
        expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        // Typed as a member might: lower case, no dash.
        expect(
            await redeemLinkCode(nativeDb, {
                userId: ALICE,
                code: code.toLowerCase().replace("-", ""),
            }),
        ).toEqual(ok(undefined));
        expect(await redeemLinkCode(nativeDb, { userId: BOB, code })).toEqual(
            err({ code: "CODE_INVALID" }),
        );
        const read = await readDiscordLink(nativeDb, token);
        expect(read.ok && read.value.linkedAt !== null).toBe(true);
        expect(await startDiscordLink(nativeDb, { token, rng })).toEqual(
            err({ code: "ALREADY_LINKED" }),
        );

        const expiring = await issued(deps, second);
        const aged = await execute(
            nativeDb,
            sql`update connector_discord_link_code set expires_at = now() where account_id = ${second}`,
        );
        expect(aged).toEqual(ok(1));
        expect(await redeemLinkCode(nativeDb, { userId: BOB, code: expiring.code })).toEqual(
            err({ code: "CODE_INVALID" }),
        );

        const fresh = await issued(deps, second);
        expect(await redeemLinkCode(nativeDb, { userId: ALICE, code: fresh.code })).toEqual(
            err({ code: "ALREADY_LINKED" }),
        );
        // A refused redeem leaves the code usable.
        expect(await redeemLinkCode(nativeDb, { userId: BOB, code: fresh.code })).toEqual(
            ok(undefined),
        );
        expect(await links(nativeDb)).toEqual(
            [
                { account_id: first, discord_user_id: ALICE },
                { account_id: second, discord_user_id: BOB },
            ].sort((a, b) => (a.account_id < b.account_id ? -1 : 1)),
        );
    });
});

test("two redeems of one code at once link it once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1002);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const accountId = await seedAccount(nativeDb, rng, "race@lucent.test");
        const { code } = await issued(deps, accountId);

        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holder = withTx(nativeDb, async (tx) => {
            const held = await execute(
                tx,
                sql`select 1 from account where id = ${accountId} for update`,
            );
            await gate;
            return held;
        });
        const racing = [
            redeemLinkCode(nativeDb, { userId: ALICE, code }),
            redeemLinkCode(nativeDb, { userId: BOB, code }),
        ];
        const parked = await waitForLockWaiters(nativeDb, 2);
        release();
        await holder;
        const outcomes = await Promise.all(racing);
        expect(parked).toBe(true);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([err({ code: "CODE_INVALID" })]);
        expect(await links(nativeDb)).toHaveLength(1);
    });
});

test("unlinking from either side removes the link and records the Discord user", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(1003);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const viaDiscord = await seedAccount(nativeDb, rng, "one@lucent.test");
        const viaSite = await seedAccount(nativeDb, rng, "two@lucent.test");
        const one = await issued(deps, viaDiscord);
        const two = await issued(deps, viaSite);
        expect((await redeemLinkCode(nativeDb, { userId: ALICE, code: one.code })).ok).toBe(true);
        expect((await redeemLinkCode(nativeDb, { userId: CAROL, code: two.code })).ok).toBe(true);

        expect(await removeDiscordLinkByUser(nativeDb, { userId: ALICE })).toEqual(
            ok({ removed: true }),
        );
        expect(await removeDiscordLinkByUser(nativeDb, { userId: ALICE })).toEqual(
            ok({ removed: false }),
        );
        expect(await removeDiscordLinkBySite(nativeDb, { token: two.token, client: null })).toEqual(
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
