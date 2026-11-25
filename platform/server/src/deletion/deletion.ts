import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { type AccountId, type BearerToken, type ClientInfo, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import type { AuthDeps } from "../auth/deps.ts";
import { type BrowserSession, lockSession, type SessionInvalid } from "../auth/sessions.ts";
import { readStanding } from "../authority/standing.ts";
import { appendAudit } from "../db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { recordNotification } from "../notify/inbox.ts";
import { type DeletionState, decideDeletion } from "./deletion.rules.ts";

// The member's side of deletion: ask, see when, keep the account. A suspended member deletes from
// the appeal session their sign-in gives them; each procedure names the one purpose it serves.
export type DeletionPurpose = "member" | "appeal";

export type DeletionStatus =
    | { readonly state: "none" }
    | { readonly state: "pending"; readonly requestedAt: EpochMs; readonly dueAt: EpochMs };

const DeletionRow = z.object({
    deletion_requested_at: EpochMs.nullable(),
    deletion_due_at: EpochMs.nullable(),
    deleted_at: EpochMs.nullable(),
});

async function gather(tx: Tx, accountId: AccountId) {
    const row = await queryOne(
        tx,
        DeletionRow,
        sql`select deletion_requested_at, deletion_due_at, deleted_at from account
            where id = ${accountId}`,
    );
    if (!row.ok) return row;
    invariant(row.value !== null, "a live session's account exists");
    const { deletion_requested_at: requestedAt, deletion_due_at: dueAt } = row.value;
    const state: DeletionState =
        row.value.deleted_at !== null
            ? { kind: "completed" }
            : dueAt !== null
              ? { kind: "pending", dueAt }
              : { kind: "none" };
    const status: DeletionStatus =
        requestedAt !== null && dueAt !== null
            ? { state: "pending", requestedAt, dueAt }
            : { state: "none" };
    return ok({ state, status });
}

export function readDeletion(
    db: Db,
    params: { readonly token: BearerToken; readonly purpose: DeletionPurpose },
): Promise<Result<DeletionStatus, SessionInvalid | DbFailure>> {
    return withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.token,
            txNow,
            purposes: [params.purpose],
        });
        if (!session.ok) return session;
        const gathered = await gather(tx, session.value.accountId);
        return gathered.ok ? ok(gathered.value.status) : gathered;
    });
}

export type RequestRefusal =
    | SessionInvalid
    | DbFailure
    | { readonly code: "STAFF_CANNOT_DELETE" }
    | { readonly code: "REAUTH_REQUIRED"; readonly withinSeconds: number };

function lastProofAt(session: BrowserSession): EpochMs {
    return EpochMs.parse(Math.max(session.authenticatedAt, session.stepUpAt ?? 0));
}

// The member is told through the security notice (inbox, mail, Discord as they chose), so a
// request they didn't make reaches them while they can still keep the account.
export function requestDeletion(
    deps: AuthDeps,
    params: {
        readonly token: BearerToken;
        readonly purpose: DeletionPurpose;
        readonly client: ClientInfo | null;
    },
): Promise<Result<{ readonly dueAt: EpochMs }, RequestRefusal>> {
    return withTx(deps.db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.token,
            txNow,
            purposes: [params.purpose],
        });
        if (!session.ok) return session;
        const { accountId } = session.value;
        const standing = await readStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        invariant(standing.value !== null, "a live session's account has a standing");
        const gathered = await gather(tx, accountId);
        if (!gathered.ok) return gathered;
        const plan = decideDeletion({
            state: gathered.value.state,
            event: "request",
            facts: {
                isRoot: standing.value.isRoot,
                holdsRole: standing.value.maxRank > 0 || standing.value.permissions.size > 0,
                lastProofAt: lastProofAt(session.value),
                now: txNow,
            },
        });
        if (!plan.ok) {
            const refusal = plan.error;
            invariant(
                refusal.code === "STAFF_CANNOT_DELETE" || refusal.code === "REAUTH_REQUIRED",
                `a live session's account can't be ${refusal.code}`,
            );
            return err(refusal);
        }
        if (plan.value.kind === "unchanged") {
            invariant(plan.value.dueAt !== null, "a repeated request has its date");
            return ok({ dueAt: plan.value.dueAt });
        }
        invariant(plan.value.kind === "request", "a request plans a request");
        const dueAt = plan.value.dueAt;
        const written = await execute(
            tx,
            sql`update account set deletion_requested_at = ${toTimestamptz(txNow)}::timestamptz,
                    deletion_due_at = ${toTimestamptz(dueAt)}::timestamptz
                where id = ${accountId}`,
        );
        if (!written.ok) return written;
        const notified = await recordNotification(tx, {
            recipient: accountId,
            notice: { kind: "security", productId: null },
            mail: deps.mailEnabled,
        });
        if (!notified.ok) return notified;
        const audited = await appendAudit(tx, {
            actorId: accountId,
            client: params.client,
            operation: "account.deletion_requested",
            target: { accountId, dueAt },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ dueAt });
    });
}

// Keeping the account: the member signed in and said so. Nothing else cancels a deletion.
export function cancelDeletion(
    db: Db,
    params: {
        readonly token: BearerToken;
        readonly purpose: DeletionPurpose;
        readonly client: ClientInfo | null;
    },
): Promise<Result<void, SessionInvalid | DbFailure>> {
    return withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.token,
            txNow,
            purposes: [params.purpose],
        });
        if (!session.ok) return session;
        const { accountId } = session.value;
        const gathered = await gather(tx, accountId);
        if (!gathered.ok) return gathered;
        const plan = decideDeletion({
            state: gathered.value.state,
            event: "cancel",
            facts: { isRoot: false, holdsRole: false, lastProofAt: null, now: txNow },
        });
        invariant(plan.ok, "a live session's account is not deleted");
        if (plan.value.kind !== "cancel") return ok(undefined);
        const written = await execute(
            tx,
            sql`update account set deletion_requested_at = null, deletion_due_at = null
                where id = ${accountId}`,
        );
        if (!written.ok) return written;
        const audited = await appendAudit(tx, {
            actorId: accountId,
            client: params.client,
            operation: "account.deletion_cancelled",
            target: { accountId },
            at: txNow,
        });
        return audited.ok ? ok(undefined) : audited;
    });
}
