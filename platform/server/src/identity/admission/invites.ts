import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, type ClientInfo, EpochMs } from "@lucent/core/scalars";
import { type AuthzRefusal, authorize, type Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockAccount } from "../auth/accounts.ts";
import type { AuthDeps } from "../auth/deps.ts";
import { lockSession } from "../auth/sessions.ts";
import { hashToken, issueToken } from "../auth/tokens.ts";
import { type Forbidden, readAsStaff } from "../authority/staff.ts";
import { lockCallerWith } from "../authority/standing.ts";
import { insertAccount } from "../authority/writers.ts";
import { findSuspendedTombstone } from "./applications.ts";
import {
    decideCreateInvite,
    decideRedeemInvite,
    decideRevokeInvite,
    decideSetAllowance,
    type Invite,
    type InviteState,
    inviteStateAt,
    MAX_PROBES,
    spentOf,
} from "./invites.rules.ts";
import { queueSetupMail } from "./setup-mail.ts";

// Members invite from an allowance staff grant. Spending allowance on someone is vouching for
// them: a redeemed invite is the edge inviter -> invitee of the invite tree, and whenever an
// invitee is suspended that counts as a strike against the inviter, which staff see and act on
// (nothing is revoked or capped automatically).

// Where web takes an invite: `/invite#` and the token, 43 base64url characters (32 random bytes).
// In the fragment, as a reset link's, it reaches no request line, log or Referer; the page posts it.
// The Discord connector's leak guard can recognize a lucent.moe invite by this shape.
export function invitePath(token: BearerToken): string {
    return `/invite#${token}`;
}

// Staff read the tree and an account's standing under the account-reading action, and grant
// allowance under account creation's: an invite is an account made on staff's behalf.
const READ_ACTION = "accounts:read";
const GRANT_ACTION = "accounts:create";

// An inviter lists their own invites; more than this many is far past any allowance staff hand out.
const OWN_LIMIT = 200;
const TREE_LIMIT = 2_000;

// Redeeming answers on a fixed floor that covers the lookup, the lock and the commit, so the
// reply never says whether the address already had an account (as a reset request does).
const REDEEM_FLOOR_MS = 350;

const InviteRow = z.object({
    id: z.string(),
    created_at: EpochMs,
    expires_at: EpochMs,
    revoked_at: EpochMs.nullable(),
    redeemed_at: EpochMs.nullable(),
    probes: z.number().int(),
});

function toInvite(row: z.output<typeof InviteRow>): Invite {
    return {
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        redeemedAt: row.redeemed_at,
        probes: row.probes,
    };
}

async function readGranted(q: Queryable, accountId: AccountId) {
    const row = await queryOne(
        q,
        z.object({ granted: z.number().int() }),
        sql`select granted from invite_allowance where account_id = ${accountId}`,
    );
    if (!row.ok) return row;
    return ok(row.value?.granted ?? 0);
}

// Every invite of the inviter that could still count as spent: redeemed, closed by probing, or
// unused and unexpired.
// The rule decides which do, from the rows.
async function readSpent(q: Queryable, accountId: AccountId, now: EpochMs) {
    const rows = await queryAll(
        q,
        InviteRow,
        sql`select id::text as id, created_at, expires_at, revoked_at, redeemed_at, probes from invite
            where inviter_id = ${accountId}
              and (redeemed_at is not null or probes >= ${MAX_PROBES}
                   or (revoked_at is null and expires_at > ${toTimestamptz(now)}::timestamptz))`,
    );
    if (!rows.ok) return rows;
    return ok(spentOf(rows.value.map(toInvite), now));
}

// A member writer: the session's account is locked first, which every invite writer for that
// inviter also takes, so an inviter's invites and allowance change one writer at a time. A
// suspended or locked account has no member session, so it creates and revokes nothing.
function asInviter<S extends Result<unknown, unknown>>(
    db: Db,
    token: BearerToken,
    work: (tx: Tx, accountId: AccountId, now: EpochMs) => Promise<S>,
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        return await work(tx, member.value.accountId, txNow);
    });
}

export type OwnInvite = {
    readonly inviteId: string;
    readonly state: InviteState;
    readonly createdAt: EpochMs;
    readonly expiresAt: EpochMs;
    readonly invitee: { readonly username: string | null } | null;
};

export function listOwnInvites(db: Db, token: BearerToken) {
    return asInviter(db, token, async (tx, accountId, now) => {
        const granted = await readGranted(tx, accountId);
        if (!granted.ok) return granted;
        const rows = await queryAll(
            tx,
            InviteRow.extend({ invitee_id: AccountId.nullable(), username: z.string().nullable() }),
            sql`select i.id::text as id, i.created_at, i.expires_at, i.revoked_at, i.redeemed_at,
                       i.probes, i.invitee_id, a.username
                from invite i left join account a on a.id = i.invitee_id
                where i.inviter_id = ${accountId}
                order by i.id desc limit ${OWN_LIMIT}`,
        );
        if (!rows.ok) return rows;
        const spent = await readSpent(tx, accountId, now);
        if (!spent.ok) return spent;
        return ok({
            granted: granted.value,
            spent: spent.value,
            invites: rows.value.map(
                (row): OwnInvite => ({
                    inviteId: row.id,
                    state: inviteStateAt(toInvite(row), now),
                    createdAt: row.created_at,
                    expiresAt: row.expires_at,
                    invitee: row.invitee_id === null ? null : { username: row.username },
                }),
            ),
        });
    });
}

// The token is in this reply only: the row keeps its hash.
export function createInvite(deps: AuthDeps, token: BearerToken) {
    return asInviter(deps.db, token, async (tx, accountId, now) => {
        const granted = await readGranted(tx, accountId);
        if (!granted.ok) return granted;
        const spent = await readSpent(tx, accountId, now);
        if (!spent.ok) return spent;
        const plan = decideCreateInvite({ granted: granted.value, spent: spent.value, now });
        if (!plan.ok) return plan;
        const issued = await issueToken(deps.rng);
        const inserted = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`insert into invite (inviter_id, token_hash, created_at, expires_at)
                values (${accountId}, ${issued.hash}, ${toTimestamptz(now)}::timestamptz,
                        ${toTimestamptz(plan.value.expiresAt)}::timestamptz)
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returning a row returns one");
        return ok({
            inviteId: inserted.value.id,
            token: issued.token,
            expiresAt: plan.value.expiresAt,
        });
    });
}

// Someone else's invite is NOT_FOUND, as an unknown one is.
export function revokeInvite(db: Db, token: BearerToken, inviteId: string) {
    return asInviter(db, token, async (tx, accountId, now) => {
        const row = await queryOne(
            tx,
            InviteRow,
            sql`select id::text as id, created_at, expires_at, revoked_at, redeemed_at, probes
                from invite
                where id = ${inviteId}::bigint and inviter_id = ${accountId} for update`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" } as const);
        const plan = decideRevokeInvite(toInvite(row.value), now);
        if (!plan.ok) return plan;
        if (!plan.value.revoke) return ok(undefined);
        const revoked = await execute(
            tx,
            sql`update invite set revoked_at = ${toTimestamptz(now)}::timestamptz, token_hash = null
                where id = ${inviteId}::bigint`,
        );
        return revoked.ok ? ok(undefined) : revoked;
    });
}

export type RedeemRefusal =
    | DbFailure
    | { readonly code: "INVITE_INVALID" }
    | { readonly code: "MAIL_DISABLED" };

// Creates the account and nothing else (no entitlement, no role), records the edge, and mails the
// setup link, as an approved application does. An address that already has an account gets the
// same answer and the invite stays unused: the holder can try another address, and only someone
// holding a live invite could learn anything from that.
export async function redeemInvite(
    deps: AuthDeps,
    params: {
        readonly token: BearerToken;
        readonly email: string;
        readonly client: ClientInfo | null;
    },
): Promise<Result<void, RedeemRefusal>> {
    const padding = Bun.sleep(REDEEM_FLOOR_MS);
    // Without a provider the setup link could reach nobody, and handing it to whoever holds the
    // invite would let them claim any address.
    if (!deps.mailEnabled) {
        await padding;
        return err({ code: "MAIL_DISABLED" });
    }
    const email = params.email.trim().toLowerCase();
    const tokenHash = await hashToken(params.token);
    const digests = await deps.emailHasher.candidates(email);
    const result = await withTx(deps.db, async (tx) => {
        const seen = await queryOne(
            tx,
            z.object({ inviter_id: AccountId }),
            sql`select inviter_id from invite where token_hash = ${tokenHash}`,
        );
        if (!seen.ok) return seen;
        if (seen.value === null) return err({ code: "INVITE_INVALID" } as const);
        const inviterId = seen.value.inviter_id;
        const inviter = await lockAccount(tx, inviterId);
        if (!inviter.ok) return inviter;
        // Read again under the inviter's lock: a redeem or revoke that held it may have changed it.
        const row = await queryOne(
            tx,
            InviteRow,
            sql`select id::text as id, created_at, expires_at, revoked_at, redeemed_at, probes
                from invite
                where token_hash = ${tokenHash} and inviter_id = ${inviterId} for update`,
        );
        if (!row.ok) return row;
        // The clock after both locks, not the transaction's start: a redeem that waited while the
        // invite expired must not be judged by a time before the wait (as readLink in
        // auth/password-reset.ts does for a reset link).
        const clock = await queryOne(
            tx,
            z.object({ now: EpochMs }),
            sql`select clock_timestamp() as now`,
        );
        if (!clock.ok) return clock;
        invariant(clock.value !== null, "a select without from returns one row");
        const now = clock.value.now;
        const taken = await queryOne(
            tx,
            z.object({ taken: z.boolean() }),
            sql`select true as taken from account where email = ${email}`,
        );
        if (!taken.ok) return taken;
        // A suspended person who deleted their account doesn't come back through an invite: the
        // redeem answers as for an address with an account, and staff see it in the audit.
        const returning = await findSuspendedTombstone(tx, digests);
        if (!returning.ok) return returning;
        const plan = decideRedeemInvite({
            invite: row.value === null ? null : toInvite(row.value),
            inviterActive: inviter.value?.isActive === true,
            emailTaken: taken.value !== null || returning.value !== null,
            now,
        });
        if (!plan.ok || row.value === null) return err({ code: "INVITE_INVALID" } as const);
        const inviteId = row.value.id;
        if (plan.value.kind === "probe") {
            const probed = await execute(
                tx,
                sql`update invite set probes = ${plan.value.probes},
                        token_hash = ${plan.value.closes ? null : tokenHash}
                    where id = ${inviteId}::bigint`,
            );
            if (!probed.ok) return probed;
            if (returning.value === null) return ok(undefined);
            // The redeemer is anonymous and the inviter did nothing now: the invite is the actor,
            // as a setup link's `invite:<id>` names it, and the redeemer's client is not kept.
            return await appendAudit(tx, {
                actorId: `invite:${inviteId}`,
                client: null,
                operation: "invite.returning_held",
                target: { accountId: returning.value, inviteId, inviterId },
                at: now,
            });
        }

        const created = await insertAccount(tx, {
            rng: deps.rng,
            email,
            issuedBy: `invite:${inviteId}`,
            txNow: now,
        });
        if (!created.ok) return created;
        const { accountId, setupToken } = created.value;
        const spent = await execute(
            tx,
            sql`update invite set redeemed_at = ${toTimestamptz(now)}::timestamptz,
                    invitee_id = ${accountId}, token_hash = null
                where id = ${inviteId}::bigint`,
        );
        if (!spent.ok) return spent;
        // The invitee is the actor: redeeming is the only act here, and the inviter did nothing at
        // this moment. Who vouched is in `invitedBy`; the setup link's `invite:<id>` names the
        // invite it came from, not a person.
        const audited = await appendAudit(tx, {
            actorId: accountId,
            client: params.client,
            operation: "account.create",
            target: { accountId, via: "invite", inviteId, invitedBy: inviterId },
            at: now,
        });
        if (!audited.ok) return audited;
        return await queueSetupMail(tx, { origin: deps.rp.origin, email, setupToken });
    });
    await padding;
    if (result.ok) return result;
    // Another invite claimed the address after the check above: the same answer as any taken one.
    if (result.error.code === "EMAIL_TAKEN") return ok(undefined);
    return err(result.error);
}

export type GrantRefusal =
    | DbFailure
    | AuthzRefusal
    | NotFound
    | { readonly code: "BELOW_SPENT" }
    | { readonly code: "INVALID_ALLOWANCE" };

type NotFound = { readonly code: "NOT_FOUND" };

// Raising or lowering what an account may spend in all; never below what it has spent already.
export async function setInviteAllowance(
    db: Db,
    params: { readonly caller: Caller; readonly accountId: AccountId; readonly granted: number },
): Promise<Result<void, GrantRefusal>> {
    return await withTx(db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.accountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.accountId);
        if (target === undefined) return err({ code: "NOT_FOUND" } as const);
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: GRANT_ACTION,
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;
        const before = await readGranted(tx, params.accountId);
        if (!before.ok) return before;
        const spent = await readSpent(tx, params.accountId, txNow);
        if (!spent.ok) return spent;
        const allowed = decideSetAllowance({ granted: params.granted, spent: spent.value });
        if (!allowed.ok) return allowed;
        if (before.value === params.granted) return ok(undefined);
        const written = await execute(
            tx,
            sql`insert into invite_allowance (account_id, granted, updated_at)
                values (${params.accountId}, ${params.granted}, ${toTimestamptz(txNow)}::timestamptz)
                on conflict (account_id) do update
                set granted = excluded.granted, updated_at = excluded.updated_at`,
        );
        if (!written.ok) return written;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "invite.allowance_set",
            target: { accountId: params.accountId, from: before.value, to: params.granted },
            at: txNow,
        });
        return audited.ok ? ok(undefined) : audited;
    });
}

// A strike is an invitee suspended. Two counts, both derived, so neither drifts from what
// happened: `ever` counts invitees with any suspension in the audit (append-only, kept forever),
// which a reinstatement cannot erase, and is the one staff weigh; `now` counts those suspended at
// this moment.
const strikeColumns = (inviter: SqlFragment) => sql`
    (select count(*) from invite e where e.inviter_id = ${inviter} and e.invitee_id is not null)
        as invitees,
    (select count(*) from invite e
        where e.inviter_id = ${inviter} and e.invitee_id is not null
          and exists (select from audit s where s.operation = 'account.suspend'
                      and s.target ->> 'accountId' = e.invitee_id)) as strikes_ever,
    (select count(*) from invite e join account s on s.id = e.invitee_id
        where e.inviter_id = ${inviter} and s.status = 'suspended') as strikes_now`;

const Count = z.coerce.number().int().nonnegative();

const StrikeRow = z.object({ invitees: Count, strikes_ever: Count, strikes_now: Count });

export type Strikes = { readonly ever: number; readonly now: number };

export type InviteStanding = {
    readonly granted: number;
    readonly spent: number;
    readonly invitedBy: { readonly accountId: AccountId; readonly username: string | null } | null;
    readonly invitees: number;
    readonly strikes: Strikes;
};

export async function readInviteStanding(
    db: Db,
    params: { readonly caller: Caller; readonly accountId: AccountId },
): Promise<Result<InviteStanding, DbFailure | Forbidden | { readonly code: "NOT_FOUND" }>> {
    return await readAsStaff<InviteStanding, DbFailure | NotFound>(
        db,
        { caller: params.caller, actions: [READ_ACTION] },
        async (q, now) => {
            const row = await queryOne(
                q,
                StrikeRow.extend({
                    inviter_id: AccountId.nullable(),
                    inviter_username: z.string().nullable(),
                }),
                sql`select i.inviter_id, p.username as inviter_username,
                       ${strikeColumns(sql`a.id`)}
                from account a
                left join invite i on i.invitee_id = a.id
                left join account p on p.id = i.inviter_id
                where a.id = ${params.accountId}`,
            );
            if (!row.ok) return row;
            if (row.value === null) return err({ code: "NOT_FOUND" } as const);
            const granted = await readGranted(q, params.accountId);
            if (!granted.ok) return granted;
            const spent = await readSpent(q, params.accountId, now);
            if (!spent.ok) return spent;
            const found = row.value;
            return ok({
                granted: granted.value,
                spent: spent.value,
                invitedBy:
                    found.inviter_id === null
                        ? null
                        : { accountId: found.inviter_id, username: found.inviter_username },
                invitees: found.invitees,
                strikes: { ever: found.strikes_ever, now: found.strikes_now },
            });
        },
    );
}

export type TreeMember = {
    readonly accountId: AccountId;
    readonly username: string | null;
    readonly status: "active" | "suspended" | "locked";
    readonly invitedBy: AccountId | null;
    readonly invitees: number;
    readonly strikes: Strikes;
};

// Everyone on an edge, oldest account first, each with who invited them; web nests them. Accounts
// neither invited nor inviting are not part of the tree.
export async function readInviteTree(
    db: Db,
    params: { readonly caller: Caller },
): Promise<
    Result<
        { readonly members: readonly TreeMember[]; readonly truncated: boolean },
        DbFailure | Forbidden
    >
> {
    return await readAsStaff(db, { caller: params.caller, actions: [READ_ACTION] }, async (q) => {
        const rows = await queryAll(
            q,
            StrikeRow.extend({
                id: AccountId,
                username: z.string().nullable(),
                status: z.enum(["active", "suspended", "locked"]),
                invited_by: AccountId.nullable(),
            }),
            sql`with members as (
                    select inviter_id as id from invite where invitee_id is not null
                    union select invitee_id from invite where invitee_id is not null)
                select a.id, a.username,
                       case when a.is_locked then 'locked' else a.status end as status,
                       i.inviter_id as invited_by,
                       ${strikeColumns(sql`a.id`)}
                from members m
                join account a on a.id = m.id
                left join invite i on i.invitee_id = a.id
                order by a.created_at, a.id
                limit ${TREE_LIMIT + 1}`,
        );
        if (!rows.ok) return rows;
        return ok({
            members: rows.value.slice(0, TREE_LIMIT).map((row) => ({
                accountId: row.id,
                username: row.username,
                status: row.status,
                invitedBy: row.invited_by,
                invitees: row.invitees,
                strikes: { ever: row.strikes_ever, now: row.strikes_now },
            })),
            truncated: rows.value.length > TREE_LIMIT,
        });
    });
}
