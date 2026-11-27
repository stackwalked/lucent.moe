import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
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
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import type { AuthDeps } from "../auth/deps.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../authority/staff.ts";
import { insertAccount } from "../authority/writers.ts";
import {
    type ApplicationFacts,
    type ApplicationState,
    decideApplication,
} from "./applications.rules.ts";
import { queueSetupMail } from "./setup-mail.ts";

// The waitlist: anyone may apply through the public form, and staff holding applications:review
// work the queue without a step-up. Approving creates the account and mails its setup link;
// access to a product is a separate staff action, so admission never grants any.

const REVIEW_ACTION = "applications:review";

// The queue is work, not an archive: the first QUEUE_LIMIT of a state.
const QUEUE_LIMIT = 100;

// The same floor as a reset request: the reply and its timing never say whether the address has
// an account or an application already.
const SUBMIT_FLOOR_MS = 350;

// The form as the contract has already bounded it (rpc/web/waitlist.ts). `knownBy` is stored as
// typed and never looked up here: whether such a member exists, is private or is suspended must
// not reach the applicant, so only staff's read of the application resolves it.
export type ApplicationInput = {
    readonly email: string;
    readonly discord: string;
    readonly experience: string;
    readonly games: string;
    readonly knownBy: string | null;
    readonly additional: string | null;
};

export async function submitApplication(
    deps: AuthDeps,
    params: { readonly input: ApplicationInput },
): Promise<Result<void, DbFailure>> {
    const padding = Bun.sleep(SUBMIT_FLOOR_MS);
    const email = params.input.email.trim().toLowerCase();
    const digests = await deps.emailHasher.candidates(email);
    const result = await withTx(deps.db, async (tx, txNow) => {
        const facts = await readAddress(tx, email);
        if (!facts.ok) return facts;
        const returning = await findSuspendedTombstone(tx, digests);
        if (!returning.ok) return returning;
        const plan = decideApplication({
            state: facts.value.state,
            event: "submit",
            facts: { ...facts.value, now: txNow },
        });
        if (!plan.ok || plan.value !== "open") return ok(undefined);
        // A concurrent submission for the address may have opened one since: it stands.
        const opened = await execute(
            tx,
            sql`insert into application (email, discord, experience, games, known_by, additional,
                                         created_at, returning_account_id)
                values (${email}, ${params.input.discord}, ${params.input.experience},
                        ${params.input.games}, ${params.input.knownBy}, ${params.input.additional},
                        ${toTimestamptz(txNow)}::timestamptz, ${returning.value})
                on conflict (email) where state = 'pending' do nothing`,
        );
        return opened.ok ? ok(undefined) : opened;
    });
    await padding;
    return result;
}

// A suspended account deleted since, whose address this is: the person is applying again, which
// staff see on the application and the applicant never does (deletion/email-hash.ts).
export async function findSuspendedTombstone(
    q: Queryable,
    digests: readonly Uint8Array[],
): Promise<Result<AccountId | null, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ id: AccountId }),
        sql`select id from account
            where email_hash = any(${digests}::bytea[]) and deleted_at is not null
              and suspended_at_deletion
            order by deleted_at desc, id limit 1`,
    );
    return row.ok ? ok(row.value?.id ?? null) : row;
}

async function readAddress(
    q: Queryable,
    email: string,
): Promise<
    Result<Omit<ApplicationFacts, "now"> & { readonly state: ApplicationState }, DbFailure>
> {
    const row = await queryOne(
        q,
        z.object({
            has_account: z.boolean(),
            state: z.enum(["pending", "approved", "declined"]).nullable(),
            decided_at: EpochMs.nullable(),
        }),
        sql`select exists (select from account where email = ${email}) as has_account,
                   l.state, l.decided_at
            from (select 1) one
            left join lateral (select state, decided_at from application where email = ${email}
                               order by id desc limit 1) l on true`,
    );
    if (!row.ok) return row;
    return ok({
        emailHasAccount: row.value?.has_account === true,
        state: row.value?.state ?? "none",
        decidedAt: row.value?.decided_at ?? null,
    });
}

const Person = z.object({ id: z.string(), username: z.string().nullable() });

const SummaryRow = z.object({
    id: z.string(),
    email: z.string(),
    games: z.string(),
    state: z.enum(["pending", "approved", "declined"]),
    created_at: EpochMs,
    decided_at: EpochMs.nullable(),
    known_by: z.string().nullable(),
    has_account: z.boolean(),
    returning_account_id: AccountId.nullable(),
});

export type ApplicationSummary = {
    readonly applicationId: string;
    readonly email: string;
    readonly games: string;
    readonly state: "pending" | "approved" | "declined";
    readonly createdAt: EpochMs;
    readonly decidedAt: EpochMs | null;
    readonly knownBy: string | null;
    // The address has an account now: an approval would be refused.
    readonly emailHasAccount: boolean;
    // The address was a suspended account's, deleted since: who is applying again.
    readonly returningAccountId: AccountId | null;
};

function toSummary(row: z.output<typeof SummaryRow>): ApplicationSummary {
    return {
        applicationId: row.id,
        email: row.email,
        games: row.games,
        state: row.state,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        knownBy: row.known_by,
        emailHasAccount: row.has_account,
        returningAccountId: row.returning_account_id,
    };
}

const SUMMARY_COLUMNS = sql`a.id::text as id, a.email, a.games, a.state, a.created_at,
    a.decided_at, a.known_by, exists (select from account x where x.email = a.email) as has_account,
    a.returning_account_id`;

// Pending ones oldest first, as a queue is worked; decided ones newest first.
export async function listApplications(
    db: Db,
    params: { readonly caller: Caller; readonly state: "pending" | "approved" | "declined" },
): Promise<
    Result<
        { readonly items: readonly ApplicationSummary[]; readonly truncated: boolean },
        DbFailure | Forbidden
    >
> {
    return await readAsStaff(db, { caller: params.caller, actions: [REVIEW_ACTION] }, async (q) => {
        const rows = await queryAll(
            q,
            SummaryRow,
            sql`select ${SUMMARY_COLUMNS} from application a where a.state = ${params.state}
                order by ${params.state === "pending" ? sql`a.id` : sql`a.decided_at desc, a.id desc`}
                limit ${QUEUE_LIMIT + 1}`,
        );
        if (!rows.ok) return rows;
        return ok({
            items: rows.value.slice(0, QUEUE_LIMIT).map(toSummary),
            truncated: rows.value.length > QUEUE_LIMIT,
        });
    });
}

export type Application = ApplicationSummary & {
    readonly experience: string;
    readonly additional: string | null;
    readonly discord: string;
    // The member the applicant named, if a username matches; it says nothing more than that.
    readonly knownByMember: { readonly accountId: AccountId; readonly username: string } | null;
    readonly decidedBy: z.output<typeof Person> | null;
    readonly accountId: AccountId | null;
};

export async function readApplication(
    db: Db,
    params: { readonly caller: Caller; readonly applicationId: string },
): Promise<Result<Application, DbFailure | Forbidden | { readonly code: "NOT_FOUND" }>> {
    return await readAsStaff<Application, DbFailure | { readonly code: "NOT_FOUND" }>(
        db,
        { caller: params.caller, actions: [REVIEW_ACTION] },
        async (q) => {
            const row = await queryOne(
                q,
                SummaryRow.extend({
                    experience: z.string(),
                    additional: z.string().nullable(),
                    discord: z.string(),
                    known_id: AccountId.nullable(),
                    known_username: z.string().nullable(),
                    decided_by: z.string().nullable(),
                    decider_username: z.string().nullable(),
                    account_id: AccountId.nullable(),
                }),
                sql`select ${SUMMARY_COLUMNS}, a.experience, a.additional, a.discord, k.id as known_id,
                       k.username as known_username, a.decided_by,
                       d.username as decider_username, a.account_id
                from application a
                left join account k
                    on k.username = lower(ltrim(a.known_by, '@'))
                left join account d on d.id = a.decided_by
                where a.id = ${params.applicationId}::bigint`,
            );
            if (!row.ok) return row;
            if (row.value === null) return err({ code: "NOT_FOUND" } as const);
            const found = row.value;
            return ok({
                ...toSummary(found),
                experience: found.experience,
                additional: found.additional,
                discord: found.discord,
                knownByMember:
                    found.known_id === null || found.known_username === null
                        ? null
                        : { accountId: found.known_id, username: found.known_username },
                decidedBy:
                    found.decided_by === null
                        ? null
                        : { id: found.decided_by, username: found.decider_username },
                accountId: found.account_id,
            });
        },
    );
}

type DeclineRefusal =
    | DbFailure
    | AuthzRefusal
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "ALREADY_DECIDED" };
type ApproveRefusal =
    | DeclineRefusal
    | { readonly code: "EMAIL_TAKEN" }
    | { readonly code: "MAIL_DISABLED" };

// Staff first, then the application row (migration 0035's lock order).
async function lockApplication(tx: Tx, applicationId: string) {
    const row = await queryOne(
        tx,
        z.object({
            email: z.string(),
            state: z.enum(["pending", "approved", "declined"]),
            decided_at: EpochMs.nullable(),
            has_account: z.boolean(),
        }),
        sql`select email, state, decided_at,
                   exists (select from account x where x.email = application.email) as has_account
            from application where id = ${applicationId}::bigint for update`,
    );
    if (!row.ok) return row;
    return ok(row.value);
}

// The setup link goes to the address and nowhere else. Without a provider nothing is approved:
// handing the link to the reviewer instead would let anyone holding applications:review, without a
// step-up, apply with any address and own its account, which only accounts:create may do.
export async function approveApplication(
    deps: AuthDeps,
    params: { readonly caller: Caller; readonly applicationId: string },
): Promise<Result<{ readonly accountId: AccountId }, ApproveRefusal>> {
    if (!deps.mailEnabled) return err({ code: "MAIL_DISABLED" });
    return await withTx(deps.db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: REVIEW_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const row = await lockApplication(tx, params.applicationId);
        if (!row.ok) return row;
        const plan = decideApplication({
            state: row.value?.state ?? "none",
            event: "approve",
            facts: {
                emailHasAccount: row.value?.has_account === true,
                decidedAt: row.value?.decided_at ?? null,
                now: txNow,
            },
        });
        if (!plan.ok) return plan;
        if (row.value === null) return err({ code: "NOT_FOUND" } as const);
        const email = row.value.email;
        const created = await insertAccount(tx, {
            rng: deps.rng,
            email,
            issuedBy: params.caller.accountId,
            txNow,
        });
        if (!created.ok) return created;
        const { accountId, setupToken } = created.value;
        const decided = await execute(
            tx,
            sql`update application set state = 'approved', account_id = ${accountId},
                    decided_at = ${toTimestamptz(txNow)}::timestamptz,
                    decided_by = ${params.caller.accountId}
                where id = ${params.applicationId}::bigint`,
        );
        if (!decided.ok) return decided;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "account.create",
            target: { accountId, via: "application", applicationId: params.applicationId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        const queued = await queueSetupMail(tx, { origin: deps.rp.origin, email, setupToken });
        if (!queued.ok) return queued;
        return ok({ accountId });
    });
}

export async function declineApplication(
    db: Db,
    params: { readonly caller: Caller; readonly applicationId: string },
): Promise<Result<void, DeclineRefusal>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: REVIEW_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const row = await lockApplication(tx, params.applicationId);
        if (!row.ok) return row;
        const plan = decideApplication({
            state: row.value?.state ?? "none",
            event: "decline",
            facts: {
                emailHasAccount: row.value?.has_account === true,
                decidedAt: row.value?.decided_at ?? null,
                now: txNow,
            },
        });
        if (!plan.ok) {
            const refusal = plan.error;
            invariant(refusal.code !== "EMAIL_TAKEN", "a decline never asks about the address");
            return err(refusal);
        }
        const decided = await execute(
            tx,
            sql`update application set state = 'declined',
                    decided_at = ${toTimestamptz(txNow)}::timestamptz,
                    decided_by = ${params.caller.accountId}
                where id = ${params.applicationId}::bigint`,
        );
        if (!decided.ok) return decided;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "application.decline",
            target: { applicationId: params.applicationId },
            at: txNow,
        });
        return audited.ok ? ok(undefined) : audited;
    });
}
