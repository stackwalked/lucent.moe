import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { decideDmSettlement, decideDmStaleCutoff } from "../src/edge/discord/dms.rules.ts";
import { readDueDms, settleDm } from "../src/edge/discord/dms.ts";
import {
    redeemLinkCode,
    removeDiscordLinkByUser,
    startDiscordLink,
} from "../src/edge/discord/links.ts";
import { openTicketFromDiscord } from "../src/edge/discord/member.ts";
import type { AuthDeps } from "../src/identity/auth/deps.ts";
import { recordNotification } from "../src/members/notify/inbox.ts";
import { setPreference } from "../src/members/notify/preferences.ts";
import { UNCLOSED_TICKETS_PER_ACCOUNT } from "../src/members/support/tickets.rules.ts";
import { listMemberTickets, openMemberTicket } from "../src/members/support/tickets.ts";
import { memberSession } from "./auth-fixtures.ts";
import { catalog, seedAccount } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const NOW = EpochMs.parse(1_800_000_000_000);
const SITE = "https://lucent.test";

describe("decideDmSettlement", () => {
    test("sent and refused are done with", () => {
        for (const outcome of ["sent", "refused"] as const) {
            expect(decideDmSettlement({ attempts: 0, outcome, txNow: NOW })).toEqual(
                ok({ action: "remove" }),
            );
        }
    });

    test("a failure is tried again three times, further apart each time, then dropped", () => {
        const waits = [0, 1, 2].map((attempts) => {
            const plan = decideDmSettlement({ attempts, outcome: "failed", txNow: NOW }).value;
            invariant(plan.action === "retry", "a retry");
            expect(plan.attempts).toBe(attempts + 1);
            return plan.nextAttemptAt - NOW;
        });
        expect(waits).toEqual([300_000, 900_000, 2_400_000]);
        expect(waits.reduce((a, b) => a + b)).toBe(60 * 60_000);
        expect(decideDmSettlement({ attempts: 3, outcome: "failed", txNow: NOW })).toEqual(
            ok({ action: "remove" }),
        );
    });

    test("DMs queued a day ago or earlier are stale", () => {
        expect(decideDmStaleCutoff(NOW)).toEqual(ok(EpochMs.parse(NOW - 24 * 60 * 60_000)));
    });
});

async function linked(deps: AuthDeps, rng: SeededRng, email: string, userId: string) {
    const accountId = await seedAccount(deps.db, rng, email);
    const token = await memberSession(deps, accountId);
    const code = await startDiscordLink(deps.db, { token, rng });
    invariant(code.ok, "a code was issued");
    expect(await redeemLinkCode(deps.db, { userId, code: code.value.code })).toEqual(ok(undefined));
    return { accountId, token };
}

function securityNotice(db: Db, recipient: AccountId) {
    return withTx(db, (tx) =>
        recordNotification(tx, {
            recipient,
            notice: { kind: "security", productId: null },
        }),
    );
}

async function queued(db: Db) {
    const rows = await queryAll(
        db,
        z.object({ account_id: z.string(), attempts: z.number() }),
        sql`select account_id, attempts from connector_discord_dm order by id`,
    );
    invariant(rows.ok, "the DM queue is readable");
    return rows.value;
}

test("a notice is queued as a DM only for a linked account that chose it, beside its inbox entry", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(4001);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const chose = await linked(deps, rng, "chose@lucent.test", "600000000000000001");
        const declined = await linked(deps, rng, "declined@lucent.test", "600000000000000002");
        const unlinkedId = await seedAccount(nativeDb, rng, "unlinked@lucent.test");
        const unlinked = await memberSession(deps, unlinkedId);
        for (const token of [chose.token, unlinked]) {
            expect(
                await setPreference(nativeDb, token, { kind: "security", discord: true }),
            ).toEqual(ok(undefined));
        }
        for (const id of [chose.accountId, declined.accountId, unlinkedId]) {
            expect((await securityNotice(nativeDb, id)).ok).toBe(true);
        }
        expect(await queued(nativeDb)).toEqual([{ account_id: chose.accountId, attempts: 0 }]);
        const entries = await queryAll(
            nativeDb,
            z.object({ count: z.coerce.number() }),
            sql`select count(*) as count from inbox_entry where kind = 'security'`,
        );
        expect(entries).toEqual(ok([{ count: 3 }]));
        const due = await readDueDms(nativeDb, { catalog: catalog(), siteOrigin: SITE });
        expect(due).toEqual(
            ok({
                dms: [
                    {
                        id: expect.any(String),
                        userId: "600000000000000001",
                        notice: { kind: "security" },
                        url: `${SITE}/account/inbox`,
                    },
                ],
            }),
        );
        // A product notice opens the product: the member may have kept it out of the inbox.
        expect(
            (
                await execute(
                    nativeDb,
                    sql`insert into connector_discord_dm
                            (account_id, kind, product_id, next_attempt_at, created_at)
                        values (${chose.accountId}, 'product_status', 'lucent-loader', now(), now())`,
                )
            ).ok,
        ).toBe(true);
        const both = await readDueDms(nativeDb, { catalog: catalog(), siteOrigin: SITE });
        invariant(both.ok, "the queue reads");
        expect(both.value.dms.map((dm) => dm.url)).toEqual([
            `${SITE}/account/inbox`,
            `${SITE}/products/lucent-loader`,
        ]);
    });
});

test("a failing DM is tried four times in all and a refused one once; the inbox keeps the notice", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(4002);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const failing = await linked(deps, rng, "failing@lucent.test", "600000000000000003");
        const closed = await linked(deps, rng, "closed@lucent.test", "600000000000000004");
        for (const member of [failing, closed]) {
            expect(
                await setPreference(nativeDb, member.token, { kind: "security", discord: true }),
            ).toEqual(ok(undefined));
            expect((await securityNotice(nativeDb, member.accountId)).ok).toBe(true);
        }
        const dueIds = async () => {
            const due = await readDueDms(nativeDb, { catalog: catalog(), siteOrigin: SITE });
            invariant(due.ok, "due DMs readable");
            return due.value.dms.map((dm) => ({ id: dm.id, userId: dm.userId }));
        };
        const [first, second] = await dueIds();
        invariant(first !== undefined && second !== undefined, "both are due");
        expect(await settleDm(nativeDb, { id: second.id, outcome: "refused" })).toEqual(
            ok(undefined),
        );
        let tries = 0;
        for (;;) {
            const due = await dueIds();
            if (due.length === 0) break;
            expect(due).toEqual([first]);
            tries += 1;
            expect(await settleDm(nativeDb, { id: first.id, outcome: "failed" })).toEqual(
                ok(undefined),
            );
            // Not due again until its wait has passed.
            expect(await dueIds()).toEqual([]);
            await execute(nativeDb, sql`update connector_discord_dm set next_attempt_at = now()`);
            invariant(tries < 10, "the retries end");
        }
        expect(tries).toBe(4);
        expect(await queued(nativeDb)).toEqual([]);
        // Settling one already gone changes nothing.
        expect(await settleDm(nativeDb, { id: first.id, outcome: "sent" })).toEqual(ok(undefined));
        const entries = await queryAll(
            nativeDb,
            z.object({ count: z.coerce.number() }),
            sql`select count(*) as count from inbox_entry`,
        );
        expect(entries).toEqual(ok([{ count: 2 }]));
    });
});

test("stale DMs, and those of an account since unlinked, are dropped unsent", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(4003);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const stale = await linked(deps, rng, "stale@lucent.test", "600000000000000005");
        const gone = await linked(deps, rng, "gone@lucent.test", "600000000000000006");
        for (const member of [stale, gone]) {
            await setPreference(nativeDb, member.token, { kind: "security", discord: true });
            await securityNotice(nativeDb, member.accountId);
        }
        await execute(
            nativeDb,
            sql`update connector_discord_dm set created_at = now() - interval '1 day'
                where account_id = ${stale.accountId}`,
        );
        expect(await removeDiscordLinkByUser(nativeDb, { userId: "600000000000000006" })).toEqual(
            ok({ removed: true }),
        );
        expect(await readDueDms(nativeDb, { catalog: catalog(), siteOrigin: SITE })).toEqual(
            ok({ dms: [] }),
        );
        expect(await queued(nativeDb)).toEqual([]);
    });
});

test("a ticket opened from Discord is the site's ticket and counts against the site's limit", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(4004);
        const deps = await createTestAuthDeps(nativeDb, rng);
        const member = await linked(deps, rng, "tickets@lucent.test", "600000000000000007");
        const open = (subject: string) =>
            openTicketFromDiscord(nativeDb, {
                catalog: catalog(),
                siteOrigin: SITE,
                userId: "600000000000000007",
                productId: null,
                subject,
                body: "it broke",
            });
        const opened = await open("from discord");
        invariant(opened.ok, "the ticket opened");
        expect(opened.value.url).toBe(`${SITE}/support/${opened.value.ticketId}`);
        for (let i = 1; i < UNCLOSED_TICKETS_PER_ACCOUNT; i += 1) {
            const fromSite = await openMemberTicket(nativeDb, member.token, {
                catalog: catalog(),
                productId: null,
                subject: `from the site ${i}`,
                body: "it broke",
            });
            expect(fromSite.ok).toBe(true);
        }
        expect(await open("one too many")).toEqual(err({ code: "TICKET_LIMIT" }));
        const listed = await listMemberTickets(nativeDb, member.token, { cursor: null });
        invariant(listed.ok, "tickets listed");
        expect(listed.value.items.map((ticket) => ticket.id)).toContain(opened.value.ticketId);

        expect(
            await openTicketFromDiscord(nativeDb, {
                catalog: catalog(),
                siteOrigin: SITE,
                userId: "600000000000000099",
                productId: null,
                subject: "nobody",
                body: "nobody",
            }),
        ).toEqual(err({ code: "NOT_LINKED" }));
        await execute(
            nativeDb,
            sql`update account set status = 'suspended' where id = ${member.accountId}`,
        );
        expect(await open("suspended")).toEqual(err({ code: "ACCOUNT_UNAVAILABLE" }));
    });
});
