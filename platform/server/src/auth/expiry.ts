import { ok, type Result } from "@lucent/core/result";
import { type Db, type DbFailure, execute, sql } from "../db/pool.ts";
import type { Job } from "../jobs/runner.ts";

export type Deleted = {
    readonly sessions: number;
    readonly flows: number;
    readonly setupLinks: number;
};

// Every read already ignores an expired session, flow or setup link; this only stops them piling
// up. Each delete stands alone: a row that expires in between is the next run's.
export async function deleteExpiredAuth(db: Db): Promise<Result<Deleted, DbFailure>> {
    const sessions = await execute(db, sql`delete from browser_session where expires_at <= now()`);
    if (!sessions.ok) return sessions;
    const flows = await execute(db, sql`delete from auth_flow where expires_at <= now()`);
    if (!flows.ok) return flows;
    const setupLinks = await execute(db, sql`delete from setup_token where expires_at <= now()`);
    if (!setupLinks.ok) return setupLinks;
    return ok({ sessions: sessions.value, flows: flows.value, setupLinks: setupLinks.value });
}

// Once a minute: the shortest-lived rows (sign-in flows) last ten minutes, so expired ones never
// outnumber a tenth of the live ones.
export function expiredAuthJob(db: Db): Job {
    return {
        name: "expired-auth",
        everyMs: 60_000,
        run: async () => {
            const deleted = await deleteExpiredAuth(db);
            if (!deleted.ok) return deleted;
            const { sessions, flows, setupLinks } = deleted.value;
            return ok(
                sessions + flows + setupLinks === 0
                    ? null
                    : `deleted ${sessions} sessions, ${flows} flows, ${setupLinks} setup links`,
            );
        },
    };
}
