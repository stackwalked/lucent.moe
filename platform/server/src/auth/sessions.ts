import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import type { CryptoRng } from "../core/rng.ts";
import { AccountId, type BearerToken, EpochMs } from "../core/scalars.ts";
import {
    type Db,
    type DbFailure,
    execute,
    type Queryable,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { hashToken, issueToken } from "./tokens.ts";

// Fixed lifetimes; a session never slides. A member signs in again after 12 hours whatever they
// did meanwhile, so a stolen cookie is worth at most that.
const SESSION_TTL_MS = {
    member: 12 * 60 * 60 * 1_000,
    setup: 15 * 60 * 1_000,
} as const;

export type SessionPurpose = keyof typeof SESSION_TTL_MS;

// How recently the holder must have proven a factor to change credentials.
export const CREDENTIAL_FRESHNESS_MS = 5 * 60 * 1_000;

export type BrowserSession = {
    readonly tokenHash: Uint8Array;
    readonly accountId: AccountId;
    readonly purpose: SessionPurpose;
    readonly expiresAt: EpochMs;
    readonly authenticatedAt: EpochMs;
    readonly stepUpAt: EpochMs | null;
};

export type SessionRefusal =
    | { readonly code: "SESSION_INVALID" }
    | { readonly code: "REAUTH_REQUIRED"; readonly withinSeconds: number };

export async function mintSession(
    tx: Tx,
    params: {
        readonly rng: CryptoRng;
        readonly accountId: AccountId;
        readonly purpose: SessionPurpose;
        readonly txNow: EpochMs;
    },
): Promise<Result<{ readonly token: BearerToken; readonly expiresAt: EpochMs }, DbFailure>> {
    const issued = await issueToken(params.rng);
    const expiresAt = EpochMs.parse(params.txNow + SESSION_TTL_MS[params.purpose]);
    const now = toTimestamptz(params.txNow);
    const inserted = await execute(
        tx,
        sql`insert into browser_session
                (token_hash, account_id, purpose, created_at, expires_at, authenticated_at)
            values (${issued.hash}, ${params.accountId}, ${params.purpose}, ${now}::timestamptz,
                    ${toTimestamptz(expiresAt)}::timestamptz, ${now}::timestamptz)`,
    );
    if (!inserted.ok) return inserted;
    return ok({ token: issued.token, expiresAt });
}

const SessionRowSchema = z.object({
    account_id: AccountId,
    purpose: z.enum(["member", "setup"]),
    expires_at: EpochMs,
    authenticated_at: EpochMs,
    step_up_at: EpochMs.nullable(),
});

async function findSession(
    q: Queryable,
    params: {
        readonly token: BearerToken;
        readonly txNow: EpochMs;
        readonly purposes: readonly SessionPurpose[];
        readonly lockAccount: "for update" | "no lock";
    },
): Promise<Result<BrowserSession, SessionRefusal | DbFailure>> {
    const tokenHash = await hashToken(params.token);
    const lock = params.lockAccount === "for update" ? sql`for update of a` : sql``;
    const row = await queryOne(
        q,
        SessionRowSchema,
        sql`select s.account_id, s.purpose, s.expires_at, s.authenticated_at, s.step_up_at
            from browser_session s
            join account a on a.id = s.account_id
            where s.token_hash = ${tokenHash}
              and s.expires_at > ${toTimestamptz(params.txNow)}::timestamptz
              and a.status = 'active' and not a.is_locked
            ${lock}`,
    );
    if (!row.ok) return row;
    const found = row.value;
    if (found === null || !params.purposes.includes(found.purpose)) {
        return err({ code: "SESSION_INVALID" });
    }
    return ok({
        tokenHash,
        accountId: found.account_id,
        purpose: found.purpose,
        expiresAt: found.expires_at,
        authenticatedAt: found.authenticated_at,
        stepUpAt: found.step_up_at,
    });
}

// What the session may do is decided against its account's standing in this transaction, so a
// suspension takes effect on the next request. Locking the account (never the session row) keeps
// the canonical lock order: every writer that changes an account's sessions locks it first.
export function lockSession(
    tx: Tx,
    params: {
        readonly token: BearerToken;
        readonly txNow: EpochMs;
        readonly purposes: readonly SessionPurpose[];
    },
): Promise<Result<BrowserSession, SessionRefusal | DbFailure>> {
    return findSession(tx, { ...params, lockAccount: "for update" });
}

export function readSession(
    q: Queryable,
    params: {
        readonly token: BearerToken;
        readonly txNow: EpochMs;
        readonly purposes: readonly SessionPurpose[];
    },
): Promise<Result<BrowserSession, SessionRefusal | DbFailure>> {
    return findSession(q, { ...params, lockAccount: "no lock" });
}

// A setup session exists to enroll credentials, so it is always fresh enough; a member session
// is when a factor was proven in the last five minutes, at sign-in or step-up.
export function requireFresh(
    session: BrowserSession,
    txNow: EpochMs,
): Result<void, SessionRefusal> {
    if (session.purpose === "setup") return ok(undefined);
    const lastProof = Math.max(session.authenticatedAt, session.stepUpAt ?? 0);
    if (txNow - lastProof <= CREDENTIAL_FRESHNESS_MS) return ok(undefined);
    return err({ code: "REAUTH_REQUIRED", withinSeconds: CREDENTIAL_FRESHNESS_MS / 1_000 });
}

export async function endSession(tx: Tx, tokenHash: Uint8Array): Promise<Result<void, DbFailure>> {
    const res = await execute(tx, sql`delete from browser_session where token_hash = ${tokenHash}`);
    if (!res.ok) return res;
    return ok(undefined);
}

// Every session of the account but `keep`: after a credential changes, whoever held the old one
// is signed out everywhere else.
export async function endOtherSessions(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly keep: Uint8Array | null },
): Promise<Result<void, DbFailure>> {
    const res =
        params.keep === null
            ? await execute(
                  tx,
                  sql`delete from browser_session where account_id = ${params.accountId}`,
              )
            : await execute(
                  tx,
                  sql`delete from browser_session
                      where account_id = ${params.accountId} and token_hash <> ${params.keep}`,
              );
    if (!res.ok) return res;
    return ok(undefined);
}

export type ResolvedSession = {
    readonly accountId: AccountId;
    readonly purpose: SessionPurpose;
    readonly expiresAt: EpochMs;
    readonly stepUpAt: EpochMs | null;
};

// What web asks on every request carrying the session cookie.
export async function resolveSession(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<ResolvedSession, SessionRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member", "setup"],
        });
        if (!session.ok) return session;
        const { accountId, purpose, expiresAt, stepUpAt } = session.value;
        return ok({ accountId, purpose, expiresAt, stepUpAt });
    });
}

// Sign-out never fails for a token that's already gone.
export async function signOut(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<void, DbFailure>> {
    const tokenHash = await hashToken(params.sessionToken);
    return await withTx(db, async (tx) => await endSession(tx, tokenHash));
}

export async function signOutOthers(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<void, SessionRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        return await endOtherSessions(tx, {
            accountId: session.value.accountId,
            keep: session.value.tokenHash,
        });
    });
}
