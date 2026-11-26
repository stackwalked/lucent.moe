import { expect, test } from "bun:test";
import { containBoundary } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newAccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryOne, sql, toTimestamptz } from "../src/base/db/pool.ts";
import { errCommit, withTx } from "../src/base/db/tx.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const CountSchema = z.object({ count: z.coerce.number().int() });

async function countRows(db: Db, table: "account" | "audit"): Promise<number | null> {
    const res = await queryOne(
        db,
        CountSchema,
        table === "account"
            ? sql`select count(*) as count from account`
            : sql`select count(*) as count from audit`,
    );
    return res.ok ? (res.value?.count ?? null) : null;
}

test("work returning err rolls back its writes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const accId = newAccountId(createSeededRng(101));
        const refused = await withTx(nativeDb, async (tx, txNow) => {
            const ins = await execute(
                tx,
                sql`insert into account (id, email, created_at)
                    values (${accId}, ${"rollback@example.test"}, ${toTimestamptz(txNow)}::timestamptz)`,
            );
            if (!ins.ok) return ins;
            return err("REFUSED_AFTER_INSERT" as const);
        });
        expect(refused).toEqual(err("REFUSED_AFTER_INSERT"));
        expect(await countRows(nativeDb, "account")).toBe(0);
    });
});

test("work returning errCommit commits its writes and still reports the error", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const denied = await withTx(nativeDb, async (tx, txNow) => {
            const ins = await execute(
                tx,
                sql`insert into audit (at, actor_id, operation, target)
                    values (${toTimestamptz(txNow)}::timestamptz, ${"system"}, ${"security.denied"}, ${"{}"}::jsonb)`,
            );
            if (!ins.ok) return ins;
            return errCommit("PERSISTED_DENIAL" as const);
        });
        expect(denied).toEqual(err("PERSISTED_DENIAL"));
        expect(await countRows(nativeDb, "audit")).toBe(1);
    });
});

test("work that drops a failed statement and returns ok is a defect, not a commit", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const outcome = await containBoundary({
            run: async () => {
                await withTx(nativeDb, async (tx) => {
                    await execute(tx, sql`select 1 / 0`);
                    return ok("pretended" as const);
                });
                return "returned" as const;
            },
            onUnhandled: (_detail, failureKind) => failureKind,
        });
        expect(outcome).toBe("defect");
    });
});

test("concurrent queries on one Tx are a defect", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const outcome = await containBoundary({
            run: async () =>
                await withTx(nativeDb, async (tx) => {
                    await Promise.all([
                        queryOne(tx, CountSchema, sql`select count(*) as count from account`),
                        queryOne(tx, CountSchema, sql`select count(*) as count from audit`),
                    ]);
                    return ok(undefined);
                }),
            onUnhandled: (_detail, failureKind) => failureKind,
        });
        expect(outcome).toBe("defect");
    });
});

test("a query blocked past statement_timeout fails as STATEMENT_TIMEOUT", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(
        async ({ nativeDb, browserDb }) => {
            const accId = newAccountId(createSeededRng(202));
            await execute(
                nativeDb,
                sql`insert into account (id, email) values (${accId}, ${"locked@example.test"})`,
            );
            const lockRow = sql`select id from account where id = ${accId} for update`;

            let releaseHolder: () => void = () => {};
            const holderGate = new Promise<void>((resolve) => {
                releaseHolder = resolve;
            });
            let holderLocked: () => void = () => {};
            const lockedReady = new Promise<void>((resolve) => {
                holderLocked = resolve;
            });
            const holder = withTx(nativeDb, async (tx) => {
                await queryOne(tx, z.object({ id: z.string() }), lockRow);
                holderLocked();
                await holderGate;
                return ok(undefined);
            });
            await lockedReady;

            const blocked = await withTx(browserDb, async (tx) => {
                const locked = await queryOne(tx, z.object({ id: z.string() }), lockRow);
                if (!locked.ok) return locked;
                return ok("acquired" as const);
            });
            releaseHolder();
            await holder;
            expect(blocked).toEqual(err({ code: "STATEMENT_TIMEOUT" }));
        },
        { browserTimeoutMs: 150 },
    );
});
