import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { deleteExpiredAuth } from "../src/auth/expiry.ts";
import { beginPasskeySignIn } from "../src/auth/sign-in.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import { memberSession, newMember, newSetupLink } from "./auth-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

test("expired sessions, flows and setup links are deleted, and live ones kept", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(901);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const live = await memberSession(deps, alice.accountId);
        const bob = await newSetupLink(deps, rng, "bob@lucent.test");
        const carol = await newSetupLink(deps, rng, "carol@lucent.test");
        const flow = await beginPasskeySignIn(deps, { flowToken: null });
        invariant(flow.ok, "a passkey sign-in starts");

        // Expired a moment after each was made, within the tables' own checks.
        const expire = async (statement: ReturnType<typeof sql>) => {
            const done = await execute(browserDb, statement);
            invariant(done.ok && done.value === 1, "one row expired");
        };
        await expire(
            sql`update browser_session set expires_at = created_at + interval '1 millisecond'
                where token_hash = ${await hashToken(alice.sessionToken)}`,
        );
        await expire(
            sql`update setup_token set expires_at = created_at + interval '1 millisecond'
                where account_id = ${bob.accountId}`,
        );
        await expire(
            sql`update auth_flow set expires_at = now() - interval '1 second'
                where token_hash = ${await hashToken(flow.value.flowToken)}`,
        );

        const deleted = await deleteExpiredAuth(browserDb);
        expect(deleted.ok && deleted.value).toEqual({ sessions: 1, flows: 1, setupLinks: 1 });

        const left = await queryOne(
            browserDb,
            z.object({ live: z.boolean(), link: z.boolean() }),
            sql`select exists (select 1 from browser_session where token_hash = ${await hashToken(live)}) as live,
                    exists (select 1 from setup_token where account_id = ${carol.accountId}) as link`,
        );
        expect(left.ok && left.value).toEqual({ live: true, link: true });
        expect(await deleteExpiredAuth(browserDb)).toEqual({
            ok: true,
            value: { sessions: 0, flows: 0, setupLinks: 0 },
        });
    });
});
