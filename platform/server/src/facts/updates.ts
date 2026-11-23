import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, readAsStaff } from "../authority/staff.ts";
import { type Db, type DbFailure, queryAll, sql } from "../db/pool.ts";
import type { BuildKey } from "./promotion.ts";
import { decideUpdateDayLatency, type UpdateDayLatency } from "./updates.rules.ts";

// The module builds starts reported, newest first, each with how long it took (or has been
// taking) to get a current fact set. runtime/starts.ts records the first report, promotion.ts the
// first coverage.

const UPDATE_LIMIT = 100;

export type UpdateDay = {
    readonly productId: string;
    readonly build: BuildKey;
    readonly firstReportedAt: EpochMs;
    readonly firstCoveredAt: EpochMs | null;
    readonly latency: UpdateDayLatency;
};

export async function listUpdateDays(
    db: Db,
    params: { readonly caller: Caller },
): Promise<Result<readonly UpdateDay[], Forbidden | DbFailure>> {
    const actions = ["facts:promote", "releases:promote"] as const;
    return await readAsStaff(db, { caller: params.caller, actions }, async (q, txNow) => {
        const rows = await queryAll(
            q,
            z.object({
                product_id: z.string(),
                name_hash: z.string(),
                time_date_stamp: z.coerce.number(),
                size_of_image: z.coerce.number(),
                first_reported_at: EpochMs,
                first_covered_at: EpochMs.nullable(),
            }),
            sql`select product_id, name_hash::text as name_hash, time_date_stamp, size_of_image,
                       first_reported_at, first_covered_at
                from module_build_seen
                order by first_reported_at desc, product_id, name_hash
                limit ${UPDATE_LIMIT}`,
        );
        if (!rows.ok) return rows;
        const days: UpdateDay[] = [];
        for (const row of rows.value) {
            const latency = decideUpdateDayLatency({
                firstReportedAt: row.first_reported_at,
                firstCoveredAt: row.first_covered_at,
                txNow,
            });
            if (!latency.ok) return latency;
            days.push({
                productId: row.product_id,
                build: {
                    nameHash: BigInt(row.name_hash).toString(16).padStart(16, "0"),
                    timeDateStamp: row.time_date_stamp,
                    sizeOfImage: row.size_of_image,
                },
                firstReportedAt: row.first_reported_at,
                firstCoveredAt: row.first_covered_at,
                latency: latency.value,
            });
        }
        return ok(days);
    });
}
