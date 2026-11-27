import type { Clock } from "@lucent/core/clock";
import { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, sql } from "../../base/db/pool.ts";
import type { BlockPair, RosterRow } from "./events.rules.ts";

// Presence's roster, read once per change of who is connected rather than once per stream or
// event: the hub fans one flush out to every stream, and this provider's memo answers the repeat
// asks inside the same flush epoch without a second query. `inGame` is a live runtime session
// (lease unexpired, unended); it names no product. The memo expires after ROSTER_MEMO_MS so a
// game start or end is reflected the next time presence flushes past that age.
//
// The snapshot is everyone connected plus the blocks among them, one read for all readers: the
// hub then names to each reader only whom no block separates them from (events.rules.ts), so no
// query runs per stream or per flush. A change to what the roster shows (last seen, visibility,
// a block) asks for a `fresh` read, which skips the memo.
export const ROSTER_MEMO_MS = 10_000;

const Row = z.object({
    accountId: AccountId,
    username: z.string(),
    avatar: z.string().nullable(),
    inGame: z.boolean(),
    shown: z.boolean(),
});

const Pair = z.object({ blocker: AccountId, blocked: AccountId });

export type RosterSnapshot = {
    readonly rows: readonly RosterRow[];
    readonly blocks: readonly BlockPair[];
};

export const EMPTY_ROSTER: RosterSnapshot = { rows: [], blocks: [] };

export type RosterProvider = (
    accountIds: readonly AccountId[],
    options?: { readonly fresh?: boolean },
) => Promise<RosterSnapshot>;

export function createRosterProvider(db: Db, clock: Clock): RosterProvider {
    let memo: {
        readonly key: string;
        readonly at: number;
        readonly value: Promise<RosterSnapshot>;
    } | null = null;
    return (accountIds, options) => {
        const key = [...accountIds].sort().join(",");
        const now = clock.now();
        if (
            options?.fresh !== true &&
            memo !== null &&
            memo.key === key &&
            now - memo.at < ROSTER_MEMO_MS
        ) {
            return memo.value;
        }
        const value = (async (): Promise<RosterSnapshot> => {
            if (accountIds.length === 0) return EMPTY_ROSTER;
            const rows = await queryAll(
                db,
                Row,
                sql`select a.id as "accountId", a.username,
                           case when p.removed_at is null then p.avatar_small end as avatar,
                           exists(select 1 from runtime_session r
                                  where r.account_id = a.id and r.ended_at is null
                                    and r.lease_expires_at > now()) as "inGame",
                           (coalesce(p.show_last_seen, true)
                            and coalesce(p.visibility, 'members') = 'members') as shown
                    from account a left join profile p on p.account_id = a.id
                    where a.id = any(${[...accountIds]}::text[])
                      and a.username is not null and a.status = 'active'
                    order by a.username asc`,
            );
            if (!rows.ok) return EMPTY_ROSTER;
            const blocks = await queryAll(
                db,
                Pair,
                sql`select blocker_id as blocker, blocked_id as blocked from account_block
                    where blocker_id = any(${[...accountIds]}::text[])
                      and blocked_id = any(${[...accountIds]}::text[])`,
            );
            // Rows without their blocks could name someone to a reader who blocked them.
            if (!blocks.ok) return EMPTY_ROSTER;
            return { rows: rows.value ?? [], blocks: blocks.value ?? [] };
        })();
        memo = { key, at: now, value };
        return value;
    };
}
