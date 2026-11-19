import { describe, expect, test } from "bun:test";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { z } from "zod";
import { parseUsername, usernameSkeleton } from "../src/authority/usernames.ts";
import { execute, queryOne, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { scalar, seedRoot } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

describe("usernames", () => {
    test("look-alike usernames fold to one skeleton", () => {
        const pairs: readonly (readonly [string, string])[] = [
            ["mika", "m1ka"],
            ["mika", "mi_ka"],
            ["mika", "rnika"],
            ["google", "g00gle"],
            ["lily", "1ily"],
        ];
        for (const [original, lookalike] of pairs) {
            expect(usernameSkeleton(lookalike)).toBe(usernameSkeleton(original));
        }
    });

    test("a username needs three letters or digits, not counting underscores", () => {
        expect(parseUsername("a_m").ok).toBe(false);
        expect(parseUsername("a_mm").ok).toBe(true);
    });

    test("an account's username cannot change outside a rename transaction", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rootId = await seedRoot(nativeDb, createSeededRng(403));

            const res = await execute(
                nativeDb,
                sql`update account set username = 'someone' where id = ${rootId}`,
            );

            expect(res).toEqual({
                ok: false,
                error: { code: "CHECK_VIOLATION", constraint: "account_username_immutable" },
            });
        });
    });

    test("an account's username can change inside a transaction that sets lucent.username_rename", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rootId = await seedRoot(nativeDb, createSeededRng(404));

            const renamed = await withTx(nativeDb, async (tx) => {
                const flag = await queryOne(
                    tx,
                    z.object({ set_config: z.string() }),
                    sql`select set_config('lucent.username_rename', 'on', true)`,
                );
                if (!flag.ok) return flag;
                const res = await execute(
                    tx,
                    sql`update account set username = 'someone' where id = ${rootId}`,
                );
                if (!res.ok) return res;
                return ok(undefined);
            });

            expect(renamed.ok).toBe(true);
            expect(
                await scalar(
                    nativeDb,
                    z.string(),
                    sql`select username as value from account where id = ${rootId}`,
                ),
            ).toBe("someone");
        });
    });
});
