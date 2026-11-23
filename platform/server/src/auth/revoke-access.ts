import { ok } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import { execute, sql, type Tx } from "../db/pool.ts";

// The browser and native writers serialize on the account. Invalidate credentials for ongoing
// access, not the enrolled devices, factors or licences used to establish a new session.
export async function revokeAccess(tx: Tx, id: AccountId) {
    for (const statement of [
        sql`update account set sign_in_cutoff = clock_timestamp() where id = ${id}`,
        sql`delete from auth_flow where account_id = ${id}`,
        sql`delete from browser_session where account_id = ${id}`,
        sql`delete from setup_token where account_id = ${id}`,
        sql`delete from password_reset where account_id = ${id}`,
        sql`update native_auth_request set code_hash = null, code_expires_at = null where account_id = ${id} and code_hash is not null`,
        sql`update native_token_family set revoked_at = now() where account_id = ${id} and revoked_at is null`,
        sql`update device_enrollment set state = 'expired', decided_at = now() where account_id = ${id} and state = 'pending'`,
        sql`update product_slot set holder_session = null where account_id = ${id} and holder_session is not null`,
        sql`update session_start set consumed_at = now(), container_key = null where account_id = ${id} and consumed_at is null`,
        sql`update runtime_session set ended_at = now(), end_reason = 'closed', key_to_server = null,
            key_to_module = null, data_key_to_server = null, data_key_to_module = null
            where account_id = ${id} and ended_at is null`,
    ]) {
        const result = await execute(tx, statement);
        if (!result.ok) return result;
    }
    return ok(undefined);
}
