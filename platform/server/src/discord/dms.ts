import type { ProductCatalog } from "@lucent/catalog/catalog";
import { ok, type Result } from "@lucent/core/result";
import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { type DmOutcome, decideDmSettlement, decideDmStaleCutoff } from "./dms.rules.ts";

export type DueDm = {
    readonly id: string;
    readonly userId: string;
    readonly notice:
        | { readonly kind: "security" }
        | { readonly kind: "product_status"; readonly product: string };
    readonly url: string;
};

const DMS_PER_READ = 20;

// Due DMs, oldest first. Stale ones, and any whose account has no Discord user any more, go
// first: there is nobody to send them to, or nothing worth sending.
export async function readDueDms(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly siteOrigin: string },
): Promise<Result<{ readonly dms: readonly DueDm[] }, DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const cutoff = decideDmStaleCutoff(txNow).value;
        const dropped = await execute(
            tx,
            sql`delete from connector_discord_dm d
                where d.created_at <= ${toTimestamptz(cutoff)}::timestamptz
                   or not exists (select 1 from connector_discord_link l
                                  where l.account_id = d.account_id)`,
        );
        if (!dropped.ok) return dropped;
        const rows = await queryAll(
            tx,
            z.object({
                id: z.string(),
                discord_user_id: z.string(),
                kind: z.enum(["security", "product_status"]),
                product_id: ProductId.nullable(),
            }),
            sql`select d.id::text as id, l.discord_user_id, d.kind, d.product_id
                from connector_discord_dm d
                join connector_discord_link l on l.account_id = d.account_id
                where d.next_attempt_at <= now()
                order by d.next_attempt_at, d.id
                limit ${DMS_PER_READ}`,
        );
        if (!rows.ok) return rows;
        const url = `${params.siteOrigin}/account/inbox`;
        return ok({
            dms: rows.value.map((row) => ({
                id: row.id,
                userId: row.discord_user_id,
                notice:
                    row.kind === "security" || row.product_id === null
                        ? { kind: "security" as const }
                        : {
                              kind: "product_status" as const,
                              product: params.catalog.get(row.product_id)?.name ?? row.product_id,
                          },
                url,
            })),
        });
    });
}

// A DM settled twice, or after it was dropped, changes nothing.
export async function settleDm(
    db: Db,
    params: { readonly id: string; readonly outcome: DmOutcome },
): Promise<Result<void, DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const row = await queryOne(
            tx,
            z.object({ attempts: z.number().int() }),
            sql`select attempts from connector_discord_dm where id = ${params.id}::bigint for update`,
        );
        if (!row.ok) return row;
        if (row.value === null) return ok(undefined);
        const plan = decideDmSettlement({
            attempts: row.value.attempts,
            outcome: params.outcome,
            txNow,
        }).value;
        const written = await execute(
            tx,
            plan.action === "remove"
                ? sql`delete from connector_discord_dm where id = ${params.id}::bigint`
                : sql`update connector_discord_dm
                      set attempts = ${plan.attempts},
                          next_attempt_at = ${toTimestamptz(plan.nextAttemptAt)}::timestamptz
                      where id = ${params.id}::bigint`,
        );
        return written.ok ? ok(undefined) : written;
    });
}
