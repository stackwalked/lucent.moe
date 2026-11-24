import { ok, type Result } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, readAsStaff } from "../authority/staff.ts";
import { type Db, type DbFailure, queryAll, sql, toTimestamptz } from "../db/pool.ts";
import { decideUsageWindow, type UsageWindow } from "./usage.rules.ts";

// Usage as runtime_session already records it; nothing is tracked for this page. A session is
// active from its start until it ended or its last lease ran out, whichever came first (a crashed
// loader's session is ended by the expiry sweep later than it stopped). Weeks are ISO weeks in UTC.

export type WeeklyActive = {
    readonly weekStart: EpochMs;
    readonly isoYear: number;
    readonly isoWeek: number;
    readonly productId: string;
    // Distinct accounts with a session active at any point in the week.
    readonly accounts: number;
};

export type ReleaseSessions = {
    readonly productId: string;
    readonly channel: string;
    readonly number: string;
    // Sessions started within the window, and the distinct accounts that started them.
    readonly sessions: number;
    readonly accounts: number;
};

export type Usage = UsageWindow & {
    readonly weeks: readonly WeeklyActive[];
    readonly releases: readonly ReleaseSessions[];
};

const Count = z.coerce.number().int().nonnegative();

export async function readUsage(
    db: Db,
    params: { readonly caller: Caller; readonly endingWith: EpochMs | null },
): Promise<Result<Usage, Forbidden | DbFailure>> {
    return await readAsStaff(
        db,
        { caller: params.caller, actions: ["audit:read"] },
        async (q, txNow) => {
            const window = decideUsageWindow(params.endingWith ?? txNow);
            if (!window.ok) return window;
            const from = toTimestamptz(window.value.from);
            const until = toTimestamptz(window.value.until);
            const weeks = await queryAll(
                q,
                z.object({
                    week_start: EpochMs,
                    iso_year: Count,
                    iso_week: Count,
                    product_id: z.string(),
                    accounts: Count,
                }),
                sql`with active as (
                        select product_id, account_id, created_at as starts,
                               least(ended_at, lease_expires_at) as ends
                        from runtime_session
                        where created_at < ${until}::timestamptz
                          and least(ended_at, lease_expires_at) > ${from}::timestamptz
                    )
                    select w.week as week_start,
                           to_char(w.week, 'IYYY') as iso_year, to_char(w.week, 'IW') as iso_week,
                           a.product_id, count(distinct a.account_id) as accounts
                    from active a
                    cross join lateral generate_series(
                        date_trunc('week', greatest(a.starts, ${from}::timestamptz)),
                        date_trunc('week', least(a.ends, ${until}::timestamptz) - interval '1 microsecond'),
                        interval '1 week') as w (week)
                    group by w.week, a.product_id
                    order by w.week desc, a.product_id`,
            );
            if (!weeks.ok) return weeks;
            const releases = await queryAll(
                q,
                z.object({
                    product_id: z.string(),
                    channel: z.string(),
                    number: z.string(),
                    sessions: Count,
                    accounts: Count,
                }),
                sql`select r.product_id, r.channel, st.release_number::text as number,
                           count(*) as sessions, count(distinct r.account_id) as accounts
                    from runtime_session r
                    join session_start st on st.id = r.start_id
                    where r.created_at >= ${from}::timestamptz
                      and r.created_at < ${until}::timestamptz
                    group by r.product_id, r.channel, st.release_number
                    order by r.product_id, r.channel, st.release_number desc`,
            );
            if (!releases.ok) return releases;
            return ok({
                ...window.value,
                weeks: weeks.value.map((row) => ({
                    weekStart: row.week_start,
                    isoYear: row.iso_year,
                    isoWeek: row.iso_week,
                    productId: row.product_id,
                    accounts: row.accounts,
                })),
                releases: releases.value.map((row) => ({
                    productId: row.product_id,
                    channel: row.channel,
                    number: row.number,
                    sessions: row.sessions,
                    accounts: row.accounts,
                })),
            });
        },
    );
}
