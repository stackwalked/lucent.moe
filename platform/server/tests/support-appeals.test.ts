import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId } from "@lucent/core/scalars";
import { z } from "zod";
import { sql } from "../src/base/db/pool.ts";
import { signInWithPassword, signInWithTotp } from "../src/identity/auth/sign-in.ts";
import { reinstateAccount, suspendAccount } from "../src/identity/authority/writers.ts";
import { readAppeal, writeAppeal } from "../src/members/support/appeals.ts";
import { listMemberResources } from "../src/members/support/resources.ts";
import {
    listMemberTickets,
    listStaffTickets,
    readStaffTicket,
    replyToTicket,
} from "../src/members/support/tickets.ts";
import { codeAt, MEMBER_PASSWORD, newMember, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, scalar, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("a suspended account signs in fully, files an appeal staff answer, and reaches nothing else with its session", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(811);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
        invariant(alice.totpSecret !== null, "alice has TOTP");
        const root = await steppedUp(browserDb, await seedRootOnce(browserDb, rng));
        const suspended = await suspendAccount({
            db: browserDb,
            caller: root,
            operationId: newOperationId(rng),
            targetAccountId: alice.accountId,
            reason: "sold access to others",
        });
        expect(suspended.ok).toBe(true);
        // Suspension ended every session alice held.
        expect(await listMemberTickets(browserDb, alice.sessionToken, { cursor: null })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );

        const flow = await signInWithPassword(deps, {
            username: "alice",
            password: MEMBER_PASSWORD,
        });
        invariant(flow.ok && flow.value.next === "secondFactor", "the password is right");
        const signedIn = await signInWithTotp(deps, {
            flowToken: flow.value.flowToken,
            code: await codeAt(browserDb, alice.totpSecret, 1),
        });
        invariant(signedIn.ok && signedIn.value.purpose === "appeal", "an appeal session");
        const appealToken = signedIn.value.sessionToken;

        const before = await readAppeal(browserDb, appealToken);
        invariant(before.ok, `reading the appeal: ${JSON.stringify(before)}`);
        expect(before.value.suspension?.reason).toBe("sold access to others");
        expect(before.value.appeal).toBeNull();

        expect(await writeAppeal(browserDb, appealToken, { body: "it was my brother" })).toEqual(
            ok(undefined),
        );
        const queue = await listStaffTickets(browserDb, {
            caller: root,
            state: "open",
            cursor: null,
        });
        invariant(queue.ok, "root reads the queue");
        const filed = queue.value.items.find((item) => item.kind === "appeal");
        invariant(filed !== undefined, "the appeal is in the queue");
        expect(filed.account.id).toBe(alice.accountId);
        const seen = await readStaffTicket(browserDb, { caller: root, ticketId: filed.id });
        expect(seen.ok && seen.value.suspension?.reason).toBe("sold access to others");
        expect(
            await replyToTicket(browserDb, {
                caller: root,
                ticketId: filed.id,
                body: "noted",
                site: { origin: "https://lucent.test", mail: true },
            }),
        ).toEqual(ok(undefined));
        // An appeal's account reaches only /appeal: the reply tells it nothing by inbox or mail.
        expect(
            await scalar(
                browserDb,
                z.coerce.number(),
                sql`select (select count(*) from inbox_entry where kind = 'ticket_reply')
                  + (select count(*) from mail_outbox where subject = 'support replied to your ticket') as value`,
            ),
        ).toBe(0);
        const answered = await readAppeal(browserDb, appealToken);
        invariant(answered.ok && answered.value.appeal !== null, "the appeal is there");
        expect(answered.value.appeal.state).toBe("answered");
        expect(answered.value.appeal.messages.map((m) => [m.fromStaff, m.body])).toEqual([
            [false, "it was my brother"],
            [true, "noted"],
        ]);

        // A member's procedures refuse the appeal session.
        expect(await listMemberTickets(browserDb, appealToken, { cursor: null })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
        expect(await listMemberResources(browserDb, appealToken, { catalog: catalog() })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );

        // Reinstated, the account signs in as a member again and the appeal session is over.
        const reinstated = await reinstateAccount({
            db: browserDb,
            caller: root,
            operationId: newOperationId(rng),
            targetAccountId: alice.accountId,
        });
        expect(reinstated.ok).toBe(true);
        expect(await readAppeal(browserDb, appealToken)).toEqual(err({ code: "SESSION_INVALID" }));
    });
});

test("an appeal session is only for a suspended account's appeal, and a member session can't read one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(812);
        const deps = await createTestAuthDeps(browserDb, rng);
        const bob = await newMember(deps, rng, { username: "bob", with: "password+totp" });
        expect(await readAppeal(browserDb, bob.sessionToken)).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
        expect(await writeAppeal(browserDb, bob.sessionToken, { body: "let me in" })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
    });
});
