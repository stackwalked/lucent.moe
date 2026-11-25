import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { revokeAccess } from "../auth/revoke-access.ts";
import { lockCallerWith } from "../authority/standing.ts";
import { forgetAvatars } from "../community/avatars.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, execute, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { type DeletionRefusal, decideDeletion } from "./deletion.rules.ts";
import type { EmailHasher } from "./email-hash.ts";

// The one writer that strips an account, and the only place that knows what goes. Everything
// below runs in one transaction under the account's lock, in the canonical lock order
// (platform/AGENTS.md): account, its devices, its entitlements, then slots and runtime sessions
// (revokeAccess), its cloud scopes, and the audit rows last. A table that references `account`
// and is not named here is left on purpose: the reason is in ACCOUNT_REFERENCES
// (deletion/references.ts), which a test holds against the schema.

export const DELETION_ACTOR = "job:deletion";

const AccountRow = z.object({
    email: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    deletion_due_at: EpochMs.nullable(),
    deleted_at: EpochMs.nullable(),
});

export type CompleteRefusal = DeletionRefusal | { readonly code: "NOT_FOUND" };

export type Completed = {
    readonly accountId: AccountId;
    readonly suspended: boolean;
    readonly entitlementsRevoked: readonly string[];
};

export async function completeDeletion(
    deps: { readonly db: Db; readonly emailHasher: EmailHasher },
    accountId: AccountId,
): Promise<Result<Completed, CompleteRefusal | DbFailure>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: { accountId, stepUpAt: null, client: null },
            targets: [],
            txNow,
        });
        if (!locked.ok) {
            return locked.error.code === "FORBIDDEN" || locked.error.code === "STEP_UP_REQUIRED"
                ? err({ code: "NOT_FOUND" } as const)
                : err(locked.error);
        }
        const standing = locked.value.subject;
        const row = await queryOne(
            tx,
            AccountRow,
            sql`select email, status, deletion_due_at, deleted_at from account where id = ${accountId}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" } as const);
        const account = row.value;
        const plan = decideDeletion({
            state:
                account.deleted_at !== null
                    ? { kind: "completed" }
                    : account.deletion_due_at !== null
                      ? { kind: "pending", dueAt: account.deletion_due_at }
                      : { kind: "none" },
            event: "complete",
            facts: {
                isRoot: standing.isRoot,
                holdsRole: standing.maxRank > 0 || standing.permissions.size > 0,
                lastProofAt: null,
                now: txNow,
            },
        });
        if (!plan.ok) return plan;
        const suspended = account.status === "suspended";
        // Hashed before any statement runs: the address is read from the row this writer clears.
        const emailDigest =
            suspended && account.email !== null
                ? await deps.emailHasher.current(account.email)
                : null;
        const stripped = await strip(tx, { accountId, email: account.email });
        if (!stripped.ok) return stripped;
        const tombstone = await execute(
            tx,
            sql`update account set email = null, username = null, reset_lock = false,
                    deletion_requested_at = null, deletion_due_at = null, deleted_at = now(),
                    email_hash = ${emailDigest?.digest ?? null}, email_hash_kid = ${emailDigest?.kid ?? null}
                where id = ${accountId}`,
        );
        if (!tombstone.ok) return tombstone;
        for (const userId of stripped.value.discordUsers) {
            // The connector removes synced roles from the Discord user an unlink audit row names
            // (discord/sync.ts), as it does for a member unlinking themself.
            const unlinked = await appendAudit(tx, {
                actorId: accountId,
                client: null,
                operation: "discord.unlink",
                target: { accountId, discordUserId: userId, via: "deletion" },
                at: txNow,
            });
            if (!unlinked.ok) return unlinked;
        }
        const audited = await appendAudit(tx, {
            actorId: DELETION_ACTOR,
            client: null,
            operation: "account.deletion_completed",
            target: {
                accountId,
                suspended,
                entitlementsRevoked: stripped.value.entitlementsRevoked,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({
            accountId,
            suspended,
            entitlementsRevoked: stripped.value.entitlementsRevoked,
        });
    });
}

const Id = z.object({ id: z.string() });

async function all(tx: Tx, statements: readonly ReturnType<typeof sql>[]) {
    for (const statement of statements) {
        const done = await execute(tx, statement);
        if (!done.ok) return done;
    }
    return ok(undefined);
}

async function strip(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly email: string | null },
): Promise<
    Result<
        {
            readonly entitlementsRevoked: readonly string[];
            readonly discordUsers: readonly string[];
        },
        DbFailure
    >
> {
    const id = params.accountId;

    // Device records stay (so a suspended person's PCs are still theirs); the name the member gave
    // a PC is their text and goes.
    const devices = await execute(
        tx,
        sql`select 1 from device where account_id = ${id} order by id for update`,
    );
    if (!devices.ok) return devices;
    const named = await execute(
        tx,
        sql`update device set name = null where account_id = ${id} and name is not null`,
    );
    if (!named.ok) return named;

    // Licences end now and their rows stay as history. No entitlement writer revokes yet; this is
    // the one, audited in the completion row.
    const entitlements = await queryAll(
        tx,
        Id,
        sql`select id from entitlement where account_id = ${id} order by id for update`,
    );
    if (!entitlements.ok) return entitlements;
    const revoked = await queryAll(
        tx,
        Id,
        sql`update entitlement set status = 'revoked'
            where account_id = ${id} and status <> 'revoked' returning id`,
    );
    if (!revoked.ok) return revoked;

    // Sessions, token families, runtime sessions, slot holds, starts and pending enrollments end
    // as they do for a suspension.
    const access = await revokeAccess(tx, id);
    if (!access.ok) return access;

    // Cloud: every scope locked (the account lock already serializes this account's cloud
    // writers, so taking all of them in product order can't deadlock), then items with their
    // versions and share links.
    const scopes = await execute(
        tx,
        sql`select 1 from cloud_scope where account_id = ${id} order by product_id for update`,
    );
    if (!scopes.ok) return scopes;
    const cloud = await all(tx, [
        sql`delete from cloud_share where account_id = ${id}`,
        sql`delete from cloud_item where account_id = ${id}`,
        sql`delete from cloud_scope where account_id = ${id}`,
    ]);
    if (!cloud.ok) return cloud;

    // Sign-in: every credential and what was in flight with it.
    const credentials = await all(tx, [
        sql`delete from passkey where account_id = ${id}`,
        sql`delete from password_credential where account_id = ${id}`,
        sql`delete from totp_credential where account_id = ${id}`,
        sql`delete from native_auth_request where account_id = ${id}`,
        sql`delete from native_token_family where account_id = ${id}`,
        sql`delete from sign_in_observation where account_id = ${id}`,
        sql`delete from sign_in_country where account_id = ${id}`,
    ]);
    if (!credentials.ok) return credentials;

    // Community. Guides go with every comment under them, whoever wrote it. Open reports about
    // what goes would wait in no queue (it joins the content), so they go too; decided ones are
    // staff's record and stay.
    const avatars = await queryAll(
        tx,
        z.object({ digest: z.string() }),
        sql`select unnest(array[avatar_large, avatar_small]) as digest
            from profile where account_id = ${id} and avatar_large is not null`,
    );
    if (!avatars.ok) return avatars;
    const community = await all(tx, [
        sql`delete from report r where r.state = 'open' and (
                (r.target_kind = 'comment' and r.target_id in (
                    select c.id from comment c
                    where c.author_id = ${id}
                       or c.guide_id in (select g.id from guide g where g.author_id = ${id})))
                or (r.target_kind = 'guide' and r.target_id in (
                    select g.id from guide g where g.author_id = ${id}))
                or (r.target_kind = 'shout' and r.target_id in (
                    select s.id from shout s where s.author_id = ${id}))
                or (r.target_kind = 'profile' and r.target_id in (
                    select p.id from profile p where p.account_id = ${id})))`,
        sql`delete from report where reporter_id = ${id}`,
        sql`delete from comment where author_id = ${id}
                or guide_id in (select g.id from guide g where g.author_id = ${id})`,
        sql`delete from guide where author_id = ${id}`,
        sql`delete from shout where author_id = ${id}`,
        sql`delete from profile where account_id = ${id}`,
        sql`delete from account_block where blocker_id = ${id} or blocked_id = ${id}`,
    ]);
    if (!community.ok) return community;
    const images = await forgetAvatars(
        tx,
        avatars.value.map((row) => row.digest),
    );
    if (!images.ok) return images;

    // Notices and what was waiting to be sent. A reset or setup mail went with its link above.
    const notify = await all(tx, [
        sql`delete from notification_preference where account_id = ${id}`,
        sql`delete from product_subscription where account_id = ${id}`,
        sql`delete from inbox_entry where account_id = ${id}`,
        sql`delete from mail_outbox where recipient = ${params.email}
                and state in ('pending', 'sending')`,
        sql`delete from connector_discord_dm where account_id = ${id}`,
        sql`delete from connector_discord_link_code where account_id = ${id}`,
    ]);
    if (!notify.ok) return notify;
    const discord = await queryAll(
        tx,
        z.object({ discord_user_id: z.string() }),
        sql`delete from connector_discord_link where account_id = ${id} returning discord_user_id`,
    );
    if (!discord.ok) return discord;

    // Admission: the account's own application and any other naming its address hold the
    // address and what the applicant wrote. Invites it issued that are still open vouch for
    // nobody now; redeemed ones are the invite tree and stay.
    const admission = await all(tx, [
        sql`delete from application where account_id = ${id} or email = ${params.email}`,
        sql`update invite set revoked_at = now(), token_hash = null
            where inviter_id = ${id} and token_hash is not null`,
    ]);
    if (!admission.ok) return admission;

    // The username: every name the account ever claimed stays taken, as a digest with nothing
    // beside it (migration 0036). Audit rows keep their ids, without the names they recorded.
    // Replay caches of the member's own requests can hold what they sent.
    const names = await all(tx, [
        sql`delete from receipt where endpoint = 'accounts.rename'
                and result ->> 'username' in (
                    select username from username_claim where account_id = ${id})`,
        sql`insert into retired_username (skeleton_digest)
            select sha256(convert_to(skeleton, 'UTF8')) from username_claim where account_id = ${id}
            on conflict do nothing`,
        sql`delete from username_claim where account_id = ${id}`,
        sql`select set_config('lucent.username_rename', 'on', true)`,
        sql`update audit set target = target - 'username'
            where operation = 'account.username_chosen' and target ->> 'accountId' = ${id}`,
        sql`update audit set target = target || '{"from": null, "to": null}'::jsonb
            where operation = 'account.rename' and target ->> 'accountId' = ${id}`,
        sql`delete from receipt where principal = ${`account:${id}`}
                or starts_with(principal, ${`${id}/`})`,
    ]);
    if (!names.ok) return names;

    return ok({
        entitlementsRevoked: revoked.value.map((row) => row.id),
        discordUsers: discord.value.map((row) => row.discord_user_id),
    });
}

// Accounts whose grace period has ended, oldest first.
export async function listDueDeletions(
    db: Db,
    limit: number,
): Promise<Result<readonly AccountId[], DbFailure>> {
    const rows = await queryAll(
        db,
        z.object({ id: AccountId }),
        sql`select id from account where deletion_due_at <= now()
            order by deletion_due_at, id limit ${limit}`,
    );
    return rows.ok ? ok(rows.value.map((row) => row.id)) : rows;
}
