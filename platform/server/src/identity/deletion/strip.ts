import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { forgetAvatars } from "../../members/community/avatars.ts";
import { revokeAccess } from "../auth/revoke-access.ts";
import { type DeletionRefusal, decideDeletion } from "./deletion.rules.ts";
import type { EmailHasher } from "./email-hash.ts";

// The one writer that strips an account, and the only place that knows what goes. Everything
// below runs in one transaction under the account's lock, in the canonical lock order
// (platform/AGENTS.md): account, its devices, its entitlements, then slots and runtime sessions
// (revokeAccess), its cloud scopes, and the audit rows last. A table that references `account`
// and is not named here is left on purpose: the reason is in ACCOUNT_REFERENCES
// (deletion/references.ts), which a test holds against the schema.

export const DELETION_ACTOR = "job:deletion";

// Any current grant holds a deletion, whatever the role carries: staff are demoted first.
export const holdsRoleSql = (accountId: AccountId) =>
    sql`exists (select 1 from account_role ar where ar.account_id = ${accountId}
                and (ar.expires_at is null or ar.expires_at > now()))`;

const AccountRow = z.object({
    email: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    is_root: z.boolean(),
    holds_role: z.boolean(),
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
        // Locked directly rather than through lockCallerWith, which leaves tombstones out.
        const row = await queryOne(
            tx,
            AccountRow,
            sql`select email, status, is_root, ${holdsRoleSql(accountId)} as holds_role,
                       deletion_due_at, deleted_at
                from account where id = ${accountId} for update`,
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
                isRoot: account.is_root,
                holdsRole: account.holds_role,
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
                    suspended_at_deletion = ${suspended},
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

async function ids(tx: Tx, statement: ReturnType<typeof sql>) {
    const rows = await queryAll(tx, Id, statement);
    return rows.ok ? ok(rows.value.map((row) => row.id)) : rows;
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
    const entitlements = await execute(
        tx,
        sql`select 1 from entitlement where account_id = ${id} order by id for update`,
    );
    if (!entitlements.ok) return entitlements;
    const revoked = await ids(
        tx,
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
    // versions and share links. The products name the cloud receipts deleted below.
    const scopes = await queryAll(
        tx,
        z.object({ product_id: z.string() }),
        sql`select product_id from cloud_scope where account_id = ${id}
            order by product_id for update`,
    );
    if (!scopes.ok) return scopes;
    // The listings go with their items (the cascade below), so their ids are read first: reports
    // about them are deleted by id in stripCommunity, which could no longer find them afterwards.
    const listings = await ids(
        tx,
        sql`select id::text as id from cloud_listing where owner_id = ${id} order by id for update`,
    );
    if (!listings.ok) return listings;
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

    const community = await stripCommunity(tx, id, listings.value);
    if (!community.ok) return community;

    // Support keeps the threads for staff; the member's open ones close without a notice, so they
    // leave the open queue (their text goes 30 days on, jobs/retention.ts).
    const tickets = await execute(
        tx,
        sql`update ticket set state = 'closed', closed_at = now()
            where account_id = ${id} and state <> 'closed'`,
    );
    if (!tickets.ok) return tickets;

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
    // address and what the applicant wrote; another applicant naming the member's username as
    // who knows them keeps nothing of it (matched folded, as claims compare names). Invites it
    // issued that are still open vouch for nobody now; redeemed ones are the invite tree and stay.
    const admission = await all(tx, [
        sql`delete from application where account_id = ${id} or email = ${params.email}`,
        sql`update application set known_by = null
            where known_by is not null
              and replace(translate(replace(lower(ltrim(trim(known_by), '@')), '_', ''),
                                    '01i', 'oll'), 'm', 'rn')
                  in (select skeleton from username_claim where account_id = ${id})`,
        sql`update invite set revoked_at = now(), token_hash = null
            where inviter_id = ${id} and token_hash is not null`,
    ]);
    if (!admission.ok) return admission;

    // Replay caches: the member's own requests (account and cloud principals) can hold what they
    // sent; staff's create receipt is keyed on a digest of the address and its result names the
    // account; staff's rename receipts hold the names.
    const principals = [
        `account:${id}`,
        ...scopes.value.map((scope) => `${id}/${scope.product_id}`),
    ];
    const receipts = await all(tx, [
        sql`delete from receipt where principal = any(${principals}::text[])`,
        sql`delete from receipt where endpoint = 'accounts.create' and result ->> 'accountId' = ${id}`,
        sql`delete from receipt where endpoint = 'accounts.rename'
                and result ->> 'username' in (
                    select username from username_claim where account_id = ${id})`,
    ]);
    if (!receipts.ok) return receipts;

    // The username: every name the account ever claimed stays taken, as a digest with nothing
    // beside it (migration 0036).
    //
    // This is the one writer that changes audit rows, and only to take out the usernames two kinds
    // of row recorded. The rows stay with their ids, operations and times; a name kept there would
    // be the member's name kept forever in a table nothing prunes. Left for the human to confirm.
    const names = await all(tx, [
        sql`insert into retired_username (skeleton_digest)
            select sha256(convert_to(skeleton, 'UTF8')) from username_claim where account_id = ${id}
            on conflict do nothing`,
        sql`delete from username_claim where account_id = ${id}`,
        sql`select set_config('lucent.username_rename', 'on', true)`,
        sql`update audit set target = target - 'username'
            where target ->> 'accountId' = ${id} and operation = 'account.username_chosen'`,
        sql`update audit set target = target || '{"from": null, "to": null}'::jsonb
            where target ->> 'accountId' = ${id} and operation = 'account.rename'`,
    ]);
    if (!names.ok) return names;

    return ok({
        entitlementsRevoked: revoked.value,
        discordUsers: discord.value.map((row) => row.discord_user_id),
    });
}

// The member's wall goes with them, and what they wrote on other walls goes with their other
// writing. Every row that goes is locked: a report filed meanwhile locks its target too
// (moderation/reports.ts), so it either finds the row gone or commits first and is closed with
// the rest. A comment on a wall takes a share lock on the owner's account row, which the deletion
// holds, so none is added between the lock and the delete. Open reports about what goes would wait
// in no queue (it joins the content), so they go; decided ones are staff's record and stay. The
// member's listings are already gone with their cloud items (copies others made keep their
// content), so their ids come from the cloud strip, which read them before deleting.
async function stripCommunity(tx: Tx, id: AccountId, listings: readonly string[]) {
    const comments = await ids(
        tx,
        sql`select id::text as id from comment
            where author_id = ${id} or profile_account_id = ${id}
            order by id for update`,
    );
    if (!comments.ok) return comments;
    const shouts = await ids(
        tx,
        sql`select id::text as id from shout where author_id = ${id} order by id for update`,
    );
    if (!shouts.ok) return shouts;
    const profile = await queryAll(
        tx,
        z.object({
            id: z.string(),
            large: z.string().nullable(),
            small: z.string().nullable(),
            banner: z.string().nullable(),
        }),
        sql`select id::text as id, avatar_large as large, avatar_small as small, banner
            from profile where account_id = ${id} for update`,
    );
    if (!profile.ok) return profile;
    const profiles = profile.value.map((row) => row.id);
    const deleted = await all(tx, [
        sql`delete from comment where id = any(${comments.value}::uuid[])`,
        sql`delete from shout where id = any(${shouts.value}::uuid[])`,
        sql`delete from profile where account_id = ${id}`,
        sql`delete from report r where r.state = 'open' and (
                (r.target_kind = 'comment' and r.target_id = any(${comments.value}::uuid[]))
                or (r.target_kind = 'shout' and r.target_id = any(${shouts.value}::uuid[]))
                or (r.target_kind = 'listing' and r.target_id = any(${listings}::uuid[]))
                or (r.target_kind = 'profile' and r.target_id = any(${profiles}::uuid[])))`,
        sql`delete from report where reporter_id = ${id}`,
        sql`delete from account_block where blocker_id = ${id} or blocked_id = ${id}`,
    ]);
    if (!deleted.ok) return deleted;
    const images = await forgetAvatars(
        tx,
        profile.value
            .flatMap((row) => [row.large, row.small, row.banner])
            .filter((d) => d !== null),
    );
    return images.ok ? ok(undefined) : images;
}

// Accounts whose grace period has ended, oldest first. Ones held by a role are counted apart, so a
// held one never takes a place in the batch.
export async function listDueDeletions(
    q: Queryable,
    limit: number,
): Promise<Result<{ readonly due: readonly AccountId[]; readonly held: number }, DbFailure>> {
    const rows = await queryAll(
        q,
        z.object({ id: AccountId }),
        sql`select a.id from account a
            where a.deletion_due_at <= now() and not a.is_root
              and not exists (select 1 from account_role ar where ar.account_id = a.id
                              and (ar.expires_at is null or ar.expires_at > now()))
            order by a.deletion_due_at, a.id limit ${limit}`,
    );
    if (!rows.ok) return rows;
    const held = await queryOne(
        q,
        z.object({ held: z.coerce.number().int() }),
        sql`select count(*) as held from account a
            where a.deletion_due_at <= now()
              and (a.is_root or exists (select 1 from account_role ar where ar.account_id = a.id
                                        and (ar.expires_at is null or ar.expires_at > now())))`,
    );
    if (!held.ok) return held;
    return ok({ due: rows.value.map((row) => row.id), held: held.value?.held ?? 0 });
}
