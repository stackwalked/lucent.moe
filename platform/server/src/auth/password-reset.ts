import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken } from "@lucent/core/scalars";
import { z } from "zod";
import { appendAudit } from "../db/audit.ts";
import { type DbFailure, execute, queryOne, sql, type Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { passwordResetMail } from "../notify/copy.ts";
import { recordNotification } from "../notify/inbox.ts";
import { lockAccount } from "./accounts.ts";
import type { AuthDeps } from "./deps.ts";
import { type PasswordRejected, prepareNewPassword } from "./password.ts";
import { revokeAccess } from "./revoke-access.ts";
import { hashToken, issueToken } from "./tokens.ts";

// Check after taking the account lock, including on redemption: role grants, suspension and
// credential writers use the same lock. Even an unrecognized or low-ranked staff role opts out.
function eligible(tx: Tx, id: AccountId) {
    return queryOne(
        tx,
        z.object({ email: z.string() }),
        sql`
        select email from account where id = ${id} and status = 'active' and not is_locked and not is_root
        and username is not null
        and not exists (select from account_role where account_id = ${id} and (expires_at is null or expires_at > now()))
        and (exists (select from passkey where account_id = ${id}) or
             exists (select from totp_credential where account_id = ${id} and confirmed))`,
    );
}

export async function requestPasswordReset(deps: AuthDeps, email: string) {
    // A fixed floor includes lookup, lock and commit, not an extra delay after target-specific work.
    const padding = Bun.sleep(350);
    const issued = await issueToken(deps.rng);
    const result = await withTx(deps.db, async (tx) => {
        const account = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where email = ${email.trim().toLowerCase()} for update skip locked`,
        );
        if (!account.ok) return account;
        if (account.value === null) return ok(undefined);
        const id = account.value.id;
        const target = await eligible(tx, id);
        if (!target.ok) return target;
        if (!target.value) return ok(undefined);
        const swept = await execute(
            tx,
            sql`delete from password_reset where account_id = ${id} and expires_at <= now()`,
        );
        if (!swept.ok) return swept;
        const inserted = await execute(
            tx,
            sql`insert into password_reset(token_hash, account_id, expires_at)
            values (${issued.hash}, ${id}, now() + interval '15 minutes') on conflict(account_id) do nothing`,
        );
        if (!inserted.ok) return inserted;
        if (!inserted.value) return ok(undefined);
        const mail = passwordResetMail(`${deps.rp.origin}/reset-password#${issued.token}`);
        const queued = await execute(
            tx,
            sql`insert into mail_outbox(recipient, subject, body, reset_hash)
            values (${target.value.email},${mail.subject},${mail.body},${issued.hash})`,
        );
        return queued.ok ? ok(undefined) : queued;
    });
    await padding;
    return result;
}

const invalid = { code: "RESET_INVALID" } as const;
export async function redeemPasswordReset(
    deps: AuthDeps,
    params: { readonly token: BearerToken; readonly password: string },
): Promise<
    Result<
        void,
        DbFailure | PasswordRejected | { readonly code: "PASSWORD_BREACHED" } | typeof invalid
    >
> {
    const hash = await hashToken(params.token);
    const found = await queryOne(
        deps.db,
        z.object({ account_id: AccountId }),
        sql`select account_id from password_reset where token_hash = ${hash} and expires_at > now()`,
    );
    if (!found.ok) return found;
    if (!found.value) return err(invalid);
    const id = found.value.account_id;
    const prepared = await prepareNewPassword(deps, params.password);
    if (!prepared.ok) return prepared;
    return withTx(deps.db, async (tx, txNow) => {
        const locked = await lockAccount(tx, id);
        if (!locked.ok) return locked;
        const target = await eligible(tx, id);
        if (!target.ok) return target;
        if (!target.value) return err(invalid);
        const consumed = await execute(
            tx,
            sql`delete from password_reset where token_hash = ${hash} and account_id = ${id} and expires_at > clock_timestamp()`,
        );
        if (!consumed.ok) return consumed;
        if (!consumed.value) return err(invalid);
        const revoked = await revokeAccess(tx, id);
        if (!revoked.ok) return revoked;
        const updated = await execute(
            tx,
            sql`insert into password_credential(account_id,hash,updated_at)
            values (${id},${prepared.value},now()) on conflict(account_id) do update set hash = excluded.hash, updated_at = now()`,
        );
        if (!updated.ok) return updated;
        const guarded = await execute(
            tx,
            sql`update account set reset_lock = true where id = ${id}`,
        );
        if (!guarded.ok) return guarded;
        const audit = await appendAudit(tx, {
            actorId: id,
            operation: "credential.password_set",
            at: txNow,
            client: null,
            target: { accountId: id, method: "email_reset" },
        });
        if (!audit.ok) return audit;
        const recorded = await recordNotification(tx, id, { kind: "security", productId: null });
        return recorded.ok ? ok(undefined) : recorded;
    });
}
