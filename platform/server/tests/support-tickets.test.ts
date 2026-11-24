import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, sql } from "../src/db/pool.ts";
import {
    closeIdleTickets,
    closeMemberTicket,
    closeStaffTicket,
    listStaffTickets,
    openMemberTicket,
    readMemberTicket,
    readStaffTicket,
    replyToTicket,
    setTicketConsent,
    writeMemberTicket,
} from "../src/support/tickets.ts";
import { catalog, grantRole, scalar, seedRole, steppedUp } from "./authority-fixtures.ts";
import { holdProduct, member } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

async function supportStaff(db: Db, rng: SeededRng, email: string) {
    const roleId = await seedRole(db, {
        id: "role_support",
        rank: 5,
        permissions: ["tickets:reply"],
    });
    const staff = await member(db, rng, email);
    await grantRole(db, { accountId: staff.id, roleId });
    return { ...staff, caller: await steppedUp(db, staff.id) };
}

async function stateOf(db: Db, ticketId: string) {
    return await scalar(
        db,
        z.string(),
        sql`select state as value from ticket where id = ${ticketId}::uuid`,
    );
}

describe("tickets", () => {
    test("a ticket walks open, answered, closed and reopened, and its thread keeps every message", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(801);
            const alice = await member(browserDb, rng, "alice@lucent.test", "alice");
            const staff = await supportStaff(browserDb, rng, "staff@lucent.test");
            const opened = await openMemberTicket(browserDb, alice.token, {
                catalog: catalog(),
                productId: null,
                subject: "the loader won't start",
                body: "it closes at once",
            });
            invariant(opened.ok, `opening failed: ${JSON.stringify(opened)}`);
            const { ticketId } = opened.value;
            expect(await stateOf(browserDb, ticketId)).toBe("open");

            expect(
                await replyToTicket(browserDb, {
                    caller: staff.caller,
                    ticketId,
                    body: "try again",
                }),
            ).toEqual(ok(undefined));
            expect(await stateOf(browserDb, ticketId)).toBe("answered");

            expect(await closeMemberTicket(browserDb, alice.token, { ticketId })).toEqual(
                ok(undefined),
            );
            expect(await stateOf(browserDb, ticketId)).toBe("closed");
            expect(
                await replyToTicket(browserDb, { caller: staff.caller, ticketId, body: "late" }),
            ).toEqual(err({ code: "TICKET_CLOSED" }));

            expect(
                await writeMemberTicket(browserDb, alice.token, { ticketId, body: "it's back" }),
            ).toEqual(ok(undefined));
            expect(await stateOf(browserDb, ticketId)).toBe("open");

            const read = await readMemberTicket(browserDb, alice.token, { ticketId });
            invariant(read.ok, "alice reads her ticket");
            expect(read.value.messages.map((m) => [m.fromStaff, m.body])).toEqual([
                [false, "it closes at once"],
                [true, "try again"],
                [false, "it's back"],
            ]);
            expect(
                await scalar(
                    browserDb,
                    z.coerce.number(),
                    sql`select count(*) as value from audit where operation = 'ticket.reply'`,
                ),
            ).toBe(1);
        });
    });

    test("another member's ticket is not found, and staff can't answer their own", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(802);
            const alice = await member(browserDb, rng, "alice@lucent.test");
            const mallory = await member(browserDb, rng, "mallory@lucent.test");
            const staff = await supportStaff(browserDb, rng, "staff@lucent.test");
            const opened = await openMemberTicket(browserDb, alice.token, {
                catalog: catalog(),
                productId: null,
                subject: "help",
                body: "help",
            });
            invariant(opened.ok, "opened");
            const { ticketId } = opened.value;
            expect(await readMemberTicket(browserDb, mallory.token, { ticketId })).toEqual(
                err({ code: "NOT_FOUND" }),
            );
            expect(
                await writeMemberTicket(browserDb, mallory.token, { ticketId, body: "mine now" }),
            ).toEqual(err({ code: "NOT_FOUND" }));

            const own = await openMemberTicket(browserDb, staff.token, {
                catalog: catalog(),
                productId: null,
                subject: "my own",
                body: "my own",
            });
            invariant(own.ok, "staff open their own");
            expect(
                await closeStaffTicket(browserDb, {
                    caller: staff.caller,
                    ticketId: own.value.ticketId,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
            expect(
                await listStaffTickets(browserDb, {
                    caller: await steppedUp(browserDb, alice.id),
                    state: "open",
                    cursor: null,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
        });
    });

    test("a ticket may name a product only the member can see", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(803);
            const alice = await member(browserDb, rng, "alice@lucent.test");
            const open = (productId: string) =>
                openMemberTicket(browserDb, alice.token, {
                    catalog: catalog(),
                    productId: ProductId.parse(productId),
                    subject: "help",
                    body: "help",
                });
            expect(await open("cs2")).toEqual(err({ code: "UNKNOWN_PRODUCT" }));
            await holdProduct(browserDb, rng, alice.id, "cs2");
            expect((await open("cs2")).ok).toBe(true);
        });
    });

    test("answered tickets close after a week without the member, open ones never do", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(804);
            const alice = await member(browserDb, rng, "alice@lucent.test");
            const staff = await supportStaff(browserDb, rng, "staff@lucent.test");
            const ticket = async (waiting: "on the member" | "on staff", idleDays: number) => {
                const opened = await openMemberTicket(browserDb, alice.token, {
                    catalog: catalog(),
                    productId: null,
                    subject: "help",
                    body: "help",
                });
                invariant(opened.ok, "opened");
                const { ticketId } = opened.value;
                if (waiting === "on the member") {
                    const replied = await replyToTicket(browserDb, {
                        caller: staff.caller,
                        ticketId,
                        body: "answer",
                    });
                    invariant(replied.ok, "answered");
                }
                await execute(
                    browserDb,
                    sql`update ticket
                        set last_activity_at = now() - make_interval(days => ${idleDays})
                        where id = ${ticketId}::uuid`,
                );
                return ticketId;
            };
            const stale = await ticket("on the member", 8);
            const exactlyAWeek = await ticket("on the member", 7);
            const recent = await ticket("on the member", 6);
            const waitingOnStaff = await ticket("on staff", 30);

            expect(await closeIdleTickets(browserDb)).toEqual(ok(2));
            expect(await stateOf(browserDb, stale)).toBe("closed");
            expect(await stateOf(browserDb, exactlyAWeek)).toBe("closed");
            expect(await stateOf(browserDb, recent)).toBe("answered");
            expect(await stateOf(browserDb, waitingOnStaff)).toBe("open");
        });
    });

    test("the member's consent to reading their configs is recorded per ticket, and lapses when it closes", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(805);
            const alice = await member(browserDb, rng, "alice@lucent.test");
            const staff = await supportStaff(browserDb, rng, "staff@lucent.test");
            const opened = await openMemberTicket(browserDb, alice.token, {
                catalog: catalog(),
                productId: null,
                subject: "my config misbehaves",
                body: "help",
            });
            invariant(opened.ok, "opened");
            const { ticketId } = opened.value;
            const readable = async () => {
                const read = await readStaffTicket(browserDb, { caller: staff.caller, ticketId });
                invariant(read.ok, `staff read: ${JSON.stringify(read)}`);
                return read.value.configReadable;
            };
            expect(await readable()).toBe(false);
            expect(
                await setTicketConsent(browserDb, alice.token, { ticketId, granted: true }),
            ).toEqual(ok(undefined));
            expect(await readable()).toBe(true);
            expect(
                await setTicketConsent(browserDb, alice.token, { ticketId, granted: false }),
            ).toEqual(ok(undefined));
            expect(await readable()).toBe(false);
            expect(
                await setTicketConsent(browserDb, alice.token, { ticketId, granted: true }),
            ).toEqual(ok(undefined));
            expect(await closeMemberTicket(browserDb, alice.token, { ticketId })).toEqual(
                ok(undefined),
            );
            expect(await readable()).toBe(false);
            expect(
                await setTicketConsent(browserDb, alice.token, { ticketId, granted: true }),
            ).toEqual(err({ code: "TICKET_CLOSED" }));
            const history = await scalar(
                browserDb,
                z.array(z.boolean()),
                sql`select array_agg(granted order by id) as value from ticket_consent
                    where ticket_id = ${ticketId}::uuid and account_id = ${alice.id}`,
            );
            expect(history).toEqual([true, false, true]);
        });
    });
});
