import { invariant } from "@lucent/core/contain";
import { ok, type Result } from "@lucent/core/result";
import {
    type AccountId,
    type BearerToken,
    type ClientInfo,
    EpochMs,
    type SessionId,
} from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/actions";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Db, type DbFailure, queryOne, sql } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readStanding } from "../authority/standing.ts";
import { readSession, type SessionInvalid, type SessionPurpose, touchSession } from "./sessions.ts";

// Who holds a session, with the standing `can()` needs. Web uses it to decide what to show;
// every procedure decides again for itself.
export type Viewer = {
    readonly sessionId: SessionId;
    readonly accountId: AccountId;
    readonly username: string | null;
    readonly purpose: SessionPurpose;
    readonly expiresAt: EpochMs;
    readonly stepUpAt: EpochMs | null;
    // A requested deletion waiting to complete: web puts it in front of the member on every page.
    readonly deletionDueAt: EpochMs | null;
    readonly standing: {
        readonly isRoot: boolean;
        readonly maxRank: number;
        readonly permissions: readonly Action[];
    };
};

// An appeal session's holder is suspended: whatever roles the account keeps, it acts as nobody.
const APPEALING = { isRoot: false, maxRank: 0, permissions: [] } as const;

// What web asks on every request carrying the session cookie.
export async function resolveViewer(
    db: Db,
    params: {
        readonly sessionToken: BearerToken;
        readonly client: ClientInfo | null;
        // A dev server's passwordOnly: every step-up counts as just made.
        readonly stepUpWaived?: boolean;
    },
): Promise<Result<Viewer, SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member", "setup", "appeal"],
        });
        if (!session.ok) return session;
        const { accountId } = session.value;
        const account = await queryOne(
            tx,
            z.object({ username: z.string().nullable(), deletion_due_at: EpochMs.nullable() }),
            sql`select username, deletion_due_at from account where id = ${accountId}`,
        );
        if (!account.ok) return account;
        invariant(account.value !== null, "a live session's account exists");
        const standing = await readStanding(tx, accountId, txNow);
        if (!standing.ok) return standing;
        invariant(standing.value !== null, "a live session's account has a standing");
        const touched = await touchSession(tx, {
            tokenHash: session.value.tokenHash,
            txNow,
            client: params.client,
        });
        if (!touched.ok) return touched;
        return ok({
            sessionId: session.value.sessionId,
            accountId,
            username: account.value.username,
            purpose: session.value.purpose,
            expiresAt: session.value.expiresAt,
            stepUpAt: params.stepUpWaived === true ? txNow : session.value.stepUpAt,
            deletionDueAt: account.value.deletion_due_at,
            standing:
                session.value.purpose === "appeal"
                    ? APPEALING
                    : {
                          isRoot: standing.value.isRoot,
                          maxRank: standing.value.maxRank,
                          permissions: [...standing.value.permissions].sort(),
                      },
        });
    });
}

// The staff member behind an admin call. Read in its own short transaction: the writer then
// re-reads the caller's standing under lock, so all this vouches for is who holds the session
// and when they last stepped up. A session ended in between can finish the one call in flight.
export async function resolveCaller(
    db: Db,
    params: {
        readonly sessionToken: BearerToken;
        readonly client: ClientInfo | null;
        // A dev server's passwordOnly: every step-up counts as just made.
        readonly stepUpWaived?: boolean;
    },
): Promise<Result<Caller, SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        return ok({
            accountId: session.value.accountId,
            stepUpAt: params.stepUpWaived === true ? txNow : session.value.stepUpAt,
            client: params.client,
        });
    });
}
