import type { Clock } from "@lucent/core/clock";
import type { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, sql } from "../../base/db/pool.ts";
import { decideRoster, type RosterEntry } from "./events.rules.ts";

// Presence's roster, read once per change of who is connected rather than once per stream or
// event: the hub fans one flush out to every stream, and this provider's memo answers the repeat
// asks inside the same flush epoch without a second query. `inGame` is a live runtime session
// (lease unexpired, unended); it names no product. The memo expires after ROSTER_MEMO_MS so a
// game start or end is reflected the next time presence flushes past that age.
export const ROSTER_MEMO_MS = 10_000;

const Row = z.object({
    username: z.string(),
    avatar: z.string().nullable(),
    inGame: z.boolean(),
    shown: z.boolean(),
});

export type RosterProvider = (accountIds: readonly AccountId[]) => Promise<readonly RosterEntry[]>;

export function createRosterProvider(db: Db, clock: Clock): RosterProvider {
    let memo: {
        readonly key: string;
        readonly at: number;
        readonly value: Promise<readonly RosterEntry[]>;
    } | null = null;
    return (accountIds) => {
        const key = [...accountIds].sort().join(",");
        const now = clock.now();
        if (memo !== null && memo.key === key && now - memo.at < ROSTER_MEMO_MS) return memo.value;
        const value = (async (): Promise<readonly RosterEntry[]> => {
            if (accountIds.length === 0) return [];
            const rows = await queryAll(
                db,
                Row,
                sql`select a.username,
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
            if (!rows.ok) return [];
            return decideRoster(rows.value ?? []);
        })();
        memo = { key, at: now, value };
        return value;
    };
}
