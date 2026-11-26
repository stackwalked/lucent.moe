import { ok, type Result } from "@lucent/core/result";
import { type Db, type DbFailure, execute, sql } from "../../base/db/pool.ts";
import type { Job } from "../../base/jobs/runner.ts";
import { RESUME_WINDOW_MS } from "./leases.ts";

// The native path's leftovers. Every read already refuses what expired; this keeps the tables
// small and ends sessions whose loader vanished, wiping their keys. Each statement stands alone
// and locks one kind of row, so none of them can deadlock against a request holding the
// canonical order.
export async function sweepNative(db: Db): Promise<Result<number, DbFailure>> {
    const statements = [
        sql`delete from dpop_proof where expires_at <= now()`,
        sql`delete from native_access_token where expires_at <= now()`,
        sql`delete from native_refresh_token where expires_at <= now()`,
        sql`delete from native_token_family f
            where not exists (select 1 from native_refresh_token t where t.family_id = f.id)
              and not exists (select 1 from native_access_token a where a.family_id = f.id)
              and f.created_at <= now() - interval '1 day'`,
        sql`delete from native_auth_request
            where expires_at <= now() and (code_expires_at is null or code_expires_at <= now())`,
        sql`update device_enrollment set state = 'expired'
            where state = 'pending' and expires_at <= now()`,
        sql`delete from session_start s
            where s.expires_at <= now()
              and not exists (select 1 from runtime_session r where r.start_id = s.id)`,
        // A crashed loader's slot frees itself once its last lease can no longer be resumed.
        sql`update product_slot set holder_session = null
            where holder_session in (
                select id from runtime_session
                where ended_at is null
                  and lease_expires_at <= now() - make_interval(secs => ${RESUME_WINDOW_MS / 1_000}))`,
        sql`update runtime_session
            set ended_at = now(), end_reason = 'expired', key_to_server = null, key_to_module = null,
                data_key_to_server = null, data_key_to_module = null,
                reports_key_to_server = null, reports_key_to_module = null
            where ended_at is null
              and lease_expires_at <= now() - make_interval(secs => ${RESUME_WINDOW_MS / 1_000})`,
    ];
    let changed = 0;
    for (const statement of statements) {
        const res = await execute(db, statement);
        if (!res.ok) return res;
        changed += res.value;
    }
    return ok(changed);
}

export function nativeExpiryJob(db: Db): Job {
    return {
        name: "native-expiry",
        everyMs: 60_000,
        run: async () => {
            const swept = await sweepNative(db);
            if (!swept.ok) return swept;
            return ok(swept.value === 0 ? null : `swept ${swept.value} native rows`);
        },
    };
}
