import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, queryOne, sql } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import type { Job } from "../../base/jobs/runner.ts";
import { recordNotification } from "../notify/inbox.ts";

// Tells a product's followers that its support dropped, once per recorded drop
// (product_support_change). Not in the transaction that recorded it: that is a member's start or
// a promotion, which hold their own account and device locks, and telling every follower there
// would lock each follower's account after them, against the canonical order, and make the start
// wait on all of them. Here each batch locks its followers' accounts first, in id order (through
// recordNotification), and writes the change row last. The row's `notified_through` moves only
// from the value this batch read, so two runners never tell anyone twice: the loser's batch
// rolls back.
//
// A drop that is no longer the product's latest change, or whose product is no longer live, is
// marked done without telling anyone: the news is already stale.

// A batch holds its followers' account locks until it commits, so it stays small: their starts and
// sign-ins wait on it.
const FOLLOWERS_PER_BATCH = 10;
const BATCHES_PER_RUN = 500;

// Who may still be told, checked under the follower's account lock (taken here in id order, the
// order recordNotification locks in too): not a suspended account, nor a deleted one (a tombstone
// has no inbox to write to). Another standing that stops notices joins
// this fragment.
const ACTIVE_FOLLOWER = sql`status = 'active' and deleted_at is null`;

const PendingRow = z.object({
    id: z.string(),
    product_id: ProductId,
    notified_through: AccountId.nullable(),
    latest: z.boolean(),
});

type Raced = { readonly code: "RACED" };

async function tellBatch(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly change: z.output<typeof PendingRow>;
    },
): Promise<Result<number, Raced | DbFailure>> {
    const { change } = params;
    return await withTx(db, async (tx) => {
        const product = params.catalog.get(change.product_id);
        const stale = !change.latest || product === undefined || product.state !== "live";
        const followers = stale
            ? ok([])
            : await queryAll(
                  tx,
                  z.object({ account_id: AccountId }),
                  sql`select account_id from product_subscription
                      where product_id = ${change.product_id}
                        and (${change.notified_through}::text is null
                             or account_id > ${change.notified_through})
                      order by account_id limit ${FOLLOWERS_PER_BATCH}`,
              );
        if (!followers.ok) return followers;
        let told = 0;
        for (const { account_id } of followers.value) {
            const active = await queryOne(
                tx,
                z.object({ id: AccountId }),
                sql`select id from account where id = ${account_id} and ${ACTIVE_FOLLOWER}
                    for update`,
            );
            if (!active.ok) return active;
            if (active.value === null) continue;
            const notified = await recordNotification(tx, {
                recipient: account_id,
                notice: {
                    kind: "product_status",
                    productId: change.product_id,
                    catalog: params.catalog,
                },
            });
            if (!notified.ok) return notified;
            told += 1;
        }
        const last = followers.value.at(-1)?.account_id ?? change.notified_through;
        const done = followers.value.length < FOLLOWERS_PER_BATCH;
        const moved = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`update product_support_change
                set notified_through = ${last},
                    notified_at = ${done ? sql`now()` : sql`null`}
                where id = ${change.id}::bigint and notified_at is null
                  and notified_through is not distinct from ${change.notified_through}::text
                returning id::text as id`,
        );
        if (!moved.ok) return moved;
        if (moved.value === null) return err({ code: "RACED" as const });
        return ok(told);
    });
}

const MAX_ATTEMPTS = 5;

// Counts a failed batch on its row; the fifth failure marks the row done, so one row that keeps
// failing does not hold back every later drop. True when it was given up.
async function countFailure(db: Db, id: string): Promise<Result<boolean, DbFailure>> {
    const counted = await queryOne(
        db,
        z.object({ given_up: z.boolean() }),
        sql`update product_support_change
            set attempts = attempts + 1,
                notified_at = case when attempts + 1 >= ${MAX_ATTEMPTS} then now() end
            where id = ${id}::bigint and notified_at is null
            returning notified_at is not null as given_up`,
    );
    if (!counted.ok) return counted;
    return ok(counted.value?.given_up ?? false);
}

export type Told = {
    readonly told: number;
    // Change rows given up on this run, after their fifth failed attempt.
    readonly givenUp: readonly string[];
};

// Oldest drop first. A failed batch ends the run (the next one tries again) unless it was the
// row's last attempt.
export async function tellFollowers(
    db: Db,
    params: { readonly catalog: ProductCatalog },
): Promise<Result<Told, DbFailure>> {
    let told = 0;
    const givenUp: string[] = [];
    for (let batch = 0; batch < BATCHES_PER_RUN; batch += 1) {
        const pending = await queryOne(
            db,
            PendingRow,
            sql`select c.id::text as id, c.product_id, c.notified_through,
                       not exists (select 1 from product_support_change n
                                   where n.product_id = c.product_id and n.id > c.id) as latest
                from product_support_change c
                where c.notified_at is null
                order by c.id limit 1`,
        );
        if (!pending.ok) return pending;
        if (pending.value === null) break;
        const sent = await tellBatch(db, { ...params, change: pending.value });
        if (!sent.ok) {
            if (sent.error.code === "RACED") continue;
            const counted = await countFailure(db, pending.value.id);
            if (!counted.ok) return counted;
            if (!counted.value) return err(sent.error);
            givenUp.push(pending.value.id);
            continue;
        }
        told += sent.value;
    }
    return ok({ told, givenUp });
}

export function followerNoticeJob(params: {
    readonly db: Db;
    readonly catalog: ProductCatalog;
}): Job {
    return {
        name: "support-followers",
        everyMs: 30 * 1_000,
        run: async () => {
            const run = await tellFollowers(params.db, params);
            if (!run.ok) return run;
            const { told, givenUp } = run.value;
            const lines = [
                ...(told === 0 ? [] : [`told ${told} followers of a support drop`]),
                ...givenUp.map(
                    (id) => `gave up on support change ${id} after ${MAX_ATTEMPTS} attempts`,
                ),
            ];
            return ok(lines.length === 0 ? null : lines.join("; "));
        },
    };
}
