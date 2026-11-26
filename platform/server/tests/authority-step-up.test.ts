import { expect, test } from "bun:test";
import type { Seconds } from "@lucent/core/brands";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, RoleId } from "@lucent/core/scalars";
import { RECENT_WINDOW_SECONDS, STEP_UP_WINDOW_SECONDS } from "@lucent/policy/policy";
import { type Db, execute, sql } from "../src/base/db/pool.ts";
import { resolveCaller } from "../src/identity/auth/viewer.ts";
import { reinstateAccount, suspendAccount, upsertRole } from "../src/identity/authority/writers.ts";
import { memberSession } from "./auth-fixtures.ts";
import { catalog, seedAccount, seedRoot } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

// Real sessions: what counts is the session's own sign-in and step-up times, read by
// resolveCaller, not a caller built by hand.
async function setup(db: Db, seed: number) {
    const rng = createSeededRng(seed);
    const auth = await createTestAuthDeps(db, rng);
    const rootId = await seedRoot(db, rng);
    const targetId = await seedAccount(db, rng, "target@step-up.test");
    const token = await memberSession(auth, rootId);
    const age = async (column: "authenticated_at" | "step_up_at", seconds: number) => {
        const moved = await execute(
            db,
            column === "authenticated_at"
                ? sql`update browser_session set authenticated_at = now() - make_interval(secs => ${seconds})
                      where account_id = ${rootId}`
                : sql`update browser_session set step_up_at = now() - make_interval(secs => ${seconds})
                      where account_id = ${rootId}`,
        );
        invariant(moved.ok, "session time moved");
    };
    const caller = async () => {
        const resolved = await resolveCaller(db, { sessionToken: token, client: null });
        invariant(resolved.ok, "caller resolved");
        return resolved.value;
    };
    const suspend = async () =>
        await suspendAccount({
            db,
            caller: await caller(),
            operationId: newOperationId(rng),
            targetAccountId: targetId,
            reason: "test",
        });
    const reinstate = async () =>
        await reinstateAccount({
            db,
            caller: await caller(),
            operationId: newOperationId(rng),
            targetAccountId: targetId,
        });
    const saveRole = async () =>
        await upsertRole({
            db,
            catalog: catalog(),
            caller: await caller(),
            operationId: newOperationId(rng),
            roleId: RoleId.parse("role_step"),
            name: "role_step",
            rank: 5,
            permissions: [],
            channelGrants: [],
        });
    return { age, suspend, reinstate, saveRole };
}

const required = (seconds: Seconds) =>
    err({ code: "STEP_UP_REQUIRED" as const, withinSeconds: seconds });

test("a staff member signed in an hour ago, never stepped up, suspends and reinstates with no prompt", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const w = await setup(nativeDb, 23_001);
        await w.age("authenticated_at", 3_600);
        expect((await w.suspend()).ok).toBe(true);
        expect((await w.reinstate()).ok).toBe(true);
    });
});

test("a recent action is refused once the sign-in is over 7 days old, and passes after a step-up", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const w = await setup(nativeDb, 23_002);
        await w.age("authenticated_at", RECENT_WINDOW_SECONDS + 60);
        expect(await w.suspend()).toEqual(required(RECENT_WINDOW_SECONDS));
        await w.age("step_up_at", 5);
        expect((await w.suspend()).ok).toBe(true);
    });
});

test("changing a role asks for a step-up an hour after sign-in, and again 31 minutes after the step-up", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const w = await setup(nativeDb, 23_003);
        await w.age("authenticated_at", 3_600);
        expect(await w.saveRole()).toEqual(required(STEP_UP_WINDOW_SECONDS));
        await w.age("step_up_at", 5);
        expect((await w.saveRole()).ok).toBe(true);
        await w.age("step_up_at", 31 * 60);
        expect(await w.saveRole()).toEqual(required(STEP_UP_WINDOW_SECONDS));
    });
});
