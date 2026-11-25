import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import type { AuthDeps } from "../src/auth/deps.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import { readPendingPosts, recordPost } from "../src/discord/feeds.ts";
import { redeemLinkCode, startDiscordLink } from "../src/discord/links.ts";
import { addRule } from "../src/discord/rules.ts";
import { readBrief, readStaffReleases, readWho } from "../src/discord/staff.ts";
import { memberSession, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, seedAccount, seedRole, seedStaff, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const SITE = "https://lucent.test";
const STAFF_CHANNEL = "700000000000000001";
const OTHER_CHANNEL = "700000000000000002";
const READER = "700000000000000010";
const PLAIN = "700000000000000011";
const NOBODY = "700000000000000012";
const SUBJECT = "700000000000000013";

async function link(deps: AuthDeps, rng: SeededRng, accountId: AccountId, userId: string) {
    const code = await startDiscordLink(deps.db, {
        token: await memberSession(deps, accountId),
        rng,
    });
    invariant(code.ok, "a code was issued");
    expect(await redeemLinkCode(deps.db, { userId, code: code.value.code })).toEqual(ok(undefined));
}

test("a staff read is answered only to a linked account holding the Action, in a staff channel, as of this call", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(5001);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const root = await steppedUp(nativeDb, await seedRootOnce(nativeDb, rng));
        const added = await addRule(nativeDb, {
            caller: root,
            catalog: catalog(),
            fields: { kind: "staff_channel", channelId: STAFF_CHANNEL },
        });
        expect(added.ok).toBe(true);
        const readerRole = await seedRole(nativeDb, {
            id: "role_reader",
            rank: 10,
            permissions: ["accounts:read", "audit:read", "releases:promote"],
        });
        const reader = await seedStaff(nativeDb, rng, {
            email: "reader@lucent.test",
            roleId: readerRole,
        });
        const plain = await seedAccount(nativeDb, rng, "plain@lucent.test");
        const subject = await seedAccount(nativeDb, rng, "subject@lucent.test");
        await execute(nativeDb, sql`update account set username = 'subject' where id = ${subject}`);
        await link(deps, rng, reader, READER);
        await link(deps, rng, plain, PLAIN);
        await link(deps, rng, subject, SUBJECT);

        const who = (userId: string, channelId: string, text = "subject") =>
            readWho(nativeDb, {
                catalog: catalog(),
                siteOrigin: SITE,
                ask: { userId, channelId },
                target: { kind: "query", text },
            });

        const answered = await who(READER, STAFF_CHANNEL);
        invariant(answered.ok, `answered: ${JSON.stringify(answered)}`);
        expect(answered.value).toMatchObject({
            accountId: subject,
            username: "subject",
            discordUserId: SUBJECT,
            url: `${SITE}/admin/accounts/${subject}`,
        });
        // What a channel may show: no email anywhere in it.
        expect(JSON.stringify(answered.value)).not.toContain("@lucent.test");
        const byMember = await readWho(nativeDb, {
            catalog: catalog(),
            siteOrigin: SITE,
            ask: { userId: READER, channelId: STAFF_CHANNEL },
            target: { kind: "member", userId: SUBJECT },
        });
        expect(byMember.ok && byMember.value.accountId).toBe(subject);
        expect(await who(READER, STAFF_CHANNEL, "nobody-here")).toEqual(err({ code: "NOT_FOUND" }));

        // Without the Action, unlinked, or outside a staff channel: one refusal, and nothing about
        // whether the account asked about exists.
        for (const [userId, channelId, text] of [
            [PLAIN, STAFF_CHANNEL, "subject"],
            [PLAIN, STAFF_CHANNEL, "nobody-here"],
            [NOBODY, STAFF_CHANNEL, "subject"],
            [READER, OTHER_CHANNEL, "subject"],
            [READER, OTHER_CHANNEL, "nobody-here"],
        ] as const) {
            expect(await who(userId, channelId, text)).toEqual(err({ code: "FORBIDDEN" }));
        }
        const ask = { userId: READER, channelId: STAFF_CHANNEL };
        expect((await readBrief(nativeDb, { siteOrigin: SITE, ask })).ok).toBe(true);
        expect(
            (await readStaffReleases(nativeDb, { catalog: catalog(), siteOrigin: SITE, ask })).ok,
        ).toBe(true);
        expect(
            await readBrief(nativeDb, {
                siteOrigin: SITE,
                ask: { userId: PLAIN, channelId: STAFF_CHANNEL },
            }),
        ).toEqual(err({ code: "FORBIDDEN" }));

        // Revoked on the site: the next call is refused, with nothing to restart or expire.
        await execute(nativeDb, sql`delete from account_role where account_id = ${reader}`);
        expect(await who(READER, STAFF_CHANNEL)).toEqual(err({ code: "FORBIDDEN" }));
        expect(await readBrief(nativeDb, { siteOrigin: SITE, ask })).toEqual(
            err({ code: "FORBIDDEN" }),
        );
        expect(
            await readStaffReleases(nativeDb, { catalog: catalog(), siteOrigin: SITE, ask }),
        ).toEqual(err({ code: "FORBIDDEN" }));
    });
});

test("a queue feed is accepted only on a channel marked staff", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(5002);
        const root = await steppedUp(nativeDb, await seedRootOnce(nativeDb, rng));
        const add = (fields: Parameters<typeof addRule>[1]["fields"]) =>
            addRule(nativeDb, { caller: root, catalog: catalog(), fields });
        for (const feed of ["tickets", "review"] as const) {
            expect(await add({ kind: "feed", channelId: OTHER_CHANNEL, feed })).toEqual(
                err({ code: "STAFF_CHANNEL_REQUIRED" }),
            );
        }
        expect((await add({ kind: "feed", channelId: OTHER_CHANNEL, feed: "status" })).ok).toBe(
            true,
        );
        expect((await add({ kind: "staff_channel", channelId: STAFF_CHANNEL })).ok).toBe(true);
        expect((await add({ kind: "feed", channelId: STAFF_CHANNEL, feed: "tickets" })).ok).toBe(
            true,
        );

        // The review queue: an open item goes out, and once decided goes out again as an edit of
        // the same message.
        expect((await add({ kind: "feed", channelId: STAFF_CHANNEL, feed: "review" })).ok).toBe(
            true,
        );
        const flagged = await seedAccount(nativeDb, rng, "flagged@lucent.test");
        const item = await queryOne(
            nativeDb,
            z.object({ id: z.string() }),
            sql`insert into review_item (account_id, risk_score, urgency_score, signals, opened_at,
                                         scored_at)
                values (${flagged}, 70, 40, '[]'::jsonb, now(), now())
                returning id::text as id`,
        );
        invariant(item.ok && item.value !== null, "a review item");
        const reviewPosts = async () => {
            const read = await readPendingPosts(nativeDb, { catalog: catalog(), siteOrigin: SITE });
            invariant(read.ok, "feeds readable");
            return read.value.posts.filter((post) => post.feed === "review");
        };
        const [open] = await reviewPosts();
        expect(open).toMatchObject({
            subject: item.value.id,
            state: "open",
            messageId: null,
            url: `${SITE}/admin/review`,
            post: { kind: "review", riskScore: 70, urgencyScore: 40, state: "open" },
        });
        invariant(open !== undefined, "posted");
        const MESSAGE = "700000000000000099";
        expect(
            await recordPost(nativeDb, {
                ruleId: open.ruleId,
                subject: open.subject,
                state: open.state,
                messageId: MESSAGE,
            }),
        ).toEqual(ok(undefined));
        expect(await reviewPosts()).toEqual([]);
        await execute(
            nativeDb,
            sql`update review_item set decided_at = now(), decided_by = ${root.accountId},
                                       outcome = 'no_action'
                where id = ${item.value.id}::bigint`,
        );
        expect(await reviewPosts()).toMatchObject([
            {
                state: "decided",
                messageId: MESSAGE,
                post: { state: "decided", outcome: "no_action" },
            },
        ]);
    });
});
