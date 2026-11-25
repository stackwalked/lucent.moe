import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { appendAudit } from "../db/audit.ts";
import {
    type DbFailure,
    execute,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { passwordResetMail } from "../notify/copy.ts";
import { recordNotification } from "../notify/inbox.ts";
import { lockAccount } from "./accounts.ts";
import type { AuthDeps } from "./deps.ts";
import { type PasswordRejected, prepareNewPassword } from "./password.ts";
import {
    decideResetLink,
    decideResetRedeem,
    decideResetRequest,
    type ResetAccount,
} from "./password-reset.rules.ts";
import { revokeAccess } from "./revoke-access.ts";
import { hashToken, issueToken } from "./tokens.ts";

const AccountFacts = z.object({
    email: z.string(),
    status: z.enum(["active", "suspended"]),
    is_locked: z.boolean(),
    is_root: z.boolean(),
    has_username: z.boolean(),
    role_forever: z.boolean(),
    role_latest_expiry: EpochMs.nullable(),
    has_second_factor: z.boolean(),
});

// Read after taking the account lock, including on redemption: role grants, suspension and
// credential writers use the same lock. The rules decide from this snapshot, never from SQL.
async function readResetAccount(tx: Tx, id: AccountId) {
    const row = await queryOne(
        tx,
        AccountFacts,
        sql`select email, status, is_locked, is_root, username is not null as has_username,
            exists (select from account_role where account_id = account.id and expires_at is null) as role_forever,
            (select max(expires_at) from account_role where account_id = account.id) as role_latest_expiry,
            (exists (select from passkey where account_id = account.id) or
             exists (select from totp_credential where account_id = account.id and confirmed)) as has_second_factor
            from account where id = ${id}`,
    );
    if (!row.ok) return row;
    if (row.value === null) return ok(null);
    const facts = row.value;
    return ok<ResetAccount>({
        email: facts.email,
        status: facts.status,
        isLocked: facts.is_locked,
        isRoot: facts.is_root,
        hasUsername: facts.has_username,
        roleForever: facts.role_forever,
        roleLatestExpiry: facts.role_latest_expiry,
        hasSecondFactor: facts.has_second_factor,
    });
}

// The clock is read here, after the account lock, not taken from the transaction's start: a
// transaction that waited for the lock would otherwise judge the link by a time before the wait
// and accept one that expired meanwhile.
async function readLink(tx: Tx, where: SqlFragment) {
    const row = await queryOne(
        tx,
        z.object({ expires_at: EpochMs.nullable(), now: EpochMs }),
        sql`select (select expires_at from password_reset where ${where}) as expires_at,
            clock_timestamp() as now`,
    );
    if (!row.ok) return row;
    invariant(row.value !== null, "a select without from returns one row");
    const { expires_at, now } = row.value;
    return ok({ link: expires_at === null ? null : { expiresAt: expires_at }, now });
}

export async function requestPasswordReset(deps: AuthDeps, email: string) {
    // A fixed floor includes lookup, lock and commit, not an extra delay after target-specific work.
    const padding = Bun.sleep(350);
    // Nobody can receive a link, so none is issued; the reply and the floor are unchanged.
    if (!deps.mailEnabled) {
        await padding;
        return ok(undefined);
    }
    const issued = await issueToken(deps.rng);
    const result = await withTx(deps.db, async (tx) => {
        // Wait for the lock rather than skipping a locked row: skipping would drop the request
        // silently exactly when the account is busy. Lock holders are short transactions that do
        // no I/O, and the floor absorbs the wait; an unknown address has no row to wait for.
        const found = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where email = ${email.trim().toLowerCase()} for update`,
        );
        if (!found.ok) return found;
        if (found.value === null) return ok(undefined);
        const id = found.value.id;
        const account = await readResetAccount(tx, id);
        if (!account.ok) return account;
        const link = await readLink(tx, sql`account_id = ${id}`);
        if (!link.ok) return link;
        const plan = decideResetRequest({
            account: account.value,
            link: link.value.link,
            now: link.value.now,
        });
        // Every refusal answers the same as success: the reply never says which account exists.
        if (!plan.ok) return ok(undefined);
        if (plan.value.replaceExpired) {
            const swept = await execute(
                tx,
                sql`delete from password_reset where account_id = ${id}`,
            );
            if (!swept.ok) return swept;
        }
        const inserted = await execute(
            tx,
            sql`insert into password_reset(token_hash, account_id, expires_at)
            values (${issued.hash}, ${id}, ${toTimestamptz(plan.value.expiresAt)}::timestamptz)
            on conflict(account_id) do nothing`,
        );
        if (!inserted.ok) return inserted;
        if (!inserted.value) return ok(undefined);
        const mail = passwordResetMail(`${deps.rp.origin}/reset-password#${issued.token}`);
        const queued = await execute(
            tx,
            sql`insert into mail_outbox(kind, recipient, subject, body, reset_hash)
            values ('reset', ${plan.value.email}, ${mail.subject}, ${mail.body}, ${issued.hash})`,
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
    // An early refusal before the expensive password hash; the authoritative check is below.
    const found = await queryOne(
        deps.db,
        z.object({ account_id: AccountId, expires_at: EpochMs, now: EpochMs }),
        sql`select account_id, expires_at, now() as now from password_reset where token_hash = ${hash}`,
    );
    if (!found.ok) return found;
    if (!found.value) return err(invalid);
    if (!decideResetLink({ expiresAt: found.value.expires_at }, found.value.now).ok)
        return err(invalid);
    const id = found.value.account_id;
    const prepared = await prepareNewPassword(deps, params.password);
    if (!prepared.ok) return prepared;
    return withTx(deps.db, async (tx, txNow) => {
        const locked = await lockAccount(tx, id);
        if (!locked.ok) return locked;
        const account = await readResetAccount(tx, id);
        if (!account.ok) return account;
        const link = await readLink(tx, sql`token_hash = ${hash} and account_id = ${id}`);
        if (!link.ok) return link;
        const plan = decideResetRedeem({
            account: account.value,
            link: link.value.link,
            now: link.value.now,
        });
        if (!plan.ok) return err(plan.error);
        const consumed = await execute(
            tx,
            sql`delete from password_reset where token_hash = ${hash} and account_id = ${id}`,
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
        const recorded = await recordNotification(tx, {
            recipient: id,
            notice: { kind: "security", productId: null },
            mail: deps.mailEnabled,
        });
        return recorded.ok ? ok(undefined) : recorded;
    });
}
