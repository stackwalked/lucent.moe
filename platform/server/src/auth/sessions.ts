import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import {
    AccountId,
    type BearerToken,
    type ClientInfo,
    EpochMs,
    newSessionId,
    SessionId,
} from "@lucent/core/scalars";
import { z } from "zod";
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
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { hashToken, issueToken } from "./tokens.ts";

// Fixed lifetimes; a session never slides. A member signs in again after 7 days whatever they did
// meanwhile; staff actions still need a passkey step-up within 30 minutes, so a stolen cookie
// buys a week of reading, not of acting.
// An appeal session is what a suspended account gets after every factor passed: half an hour to
// file or follow its appeal, and nothing else.
const SESSION_TTL_MS = {
    member: 7 * 24 * 60 * 60 * 1_000,
    setup: 30 * 60 * 1_000,
    appeal: 30 * 60 * 1_000,
} as const;

// Resolving a session refreshes `last_seen_at` at most this often, so browsing isn't a database
// write per request.
const LAST_SEEN_GRANULARITY_MS = 5 * 60 * 1_000;

export type SessionPurpose = keyof typeof SESSION_TTL_MS;

// How recently the holder must have proven a factor to change credentials.
export const CREDENTIAL_FRESHNESS_MS = 5 * 60 * 1_000;

export type BrowserSession = {
    readonly tokenHash: Uint8Array;
    readonly sessionId: SessionId;
    readonly accountId: AccountId;
    readonly purpose: SessionPurpose;
    readonly expiresAt: EpochMs;
    readonly authenticatedAt: EpochMs;
    readonly stepUpAt: EpochMs | null;
};

export type SessionInvalid = { readonly code: "SESSION_INVALID" };

export type SessionRefusal =
    | SessionInvalid
    | { readonly code: "REAUTH_REQUIRED"; readonly withinSeconds: number };

export async function mintSession(
    tx: Tx,
    params: {
        readonly rng: CryptoRng;
        readonly accountId: AccountId;
        readonly purpose: SessionPurpose;
        readonly txNow: EpochMs;
        readonly client: ClientInfo | null;
    },
): Promise<Result<{ readonly token: BearerToken; readonly expiresAt: EpochMs }, DbFailure>> {
    const issued = await issueToken(params.rng);
    const sessionId = newSessionId(params.rng);
    const expiresAt = EpochMs.parse(params.txNow + SESSION_TTL_MS[params.purpose]);
    const now = toTimestamptz(params.txNow);
    const inserted = await execute(
        tx,
        sql`insert into browser_session
                (token_hash, public_id, account_id, purpose, created_at, expires_at,
                 authenticated_at, last_seen_at, client_ip, user_agent)
            values (${issued.hash}, ${sessionId}, ${params.accountId}, ${params.purpose},
                    ${now}::timestamptz, ${toTimestamptz(expiresAt)}::timestamptz,
                    ${now}::timestamptz, ${now}::timestamptz, ${params.client?.ip ?? null}::inet,
                    ${params.client?.userAgent ?? null})`,
    );
    if (!inserted.ok) return inserted;
    return ok({ token: issued.token, expiresAt });
}

const SessionRowSchema = z.object({
    public_id: SessionId,
    account_id: AccountId,
    purpose: z.enum(["member", "setup", "appeal"]),
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
): Promise<Result<BrowserSession, SessionInvalid | DbFailure>> {
    const tokenHash = await hashToken(params.token);
    const lock = params.lockAccount === "for update" ? sql`for update of a` : sql``;
    const row = await queryOne(
        q,
        SessionRowSchema,
        sql`select s.public_id, s.account_id, s.purpose, s.expires_at, s.authenticated_at, s.step_up_at
            from browser_session s
            join account a on a.id = s.account_id
            where s.token_hash = ${tokenHash}
              and s.expires_at > ${toTimestamptz(params.txNow)}::timestamptz
              and not a.is_locked
              and a.deleted_at is null
              and a.status = case when s.purpose = 'appeal' then 'suspended' else 'active' end
            ${lock}`,
    );
    if (!row.ok) return row;
    const found = row.value;
    if (found === null || !params.purposes.includes(found.purpose)) {
        return err({ code: "SESSION_INVALID" });
    }
    return ok({
        tokenHash,
        sessionId: found.public_id,
        accountId: found.account_id,
        purpose: found.purpose,
        expiresAt: found.expires_at,
        authenticatedAt: found.authenticated_at,
        stepUpAt: found.step_up_at,
    });
}

// What the session may do is decided against its account's standing in this transaction, so a
// suspension takes effect on the next request; an appeal session lives only while the account
// stays suspended, so a reinstatement ends it. Locking the account (never the session row) keeps
// the canonical lock order: every writer that changes an account's sessions locks it first.
export async function lockSession(
    tx: Tx,
    params: {
        readonly token: BearerToken;
        readonly txNow: EpochMs;
        readonly purposes: readonly SessionPurpose[];
    },
): Promise<Result<BrowserSession, SessionInvalid | DbFailure>> {
    const seen = await findSession(tx, { ...params, lockAccount: "for update" });
    if (!seen.ok) return seen;
    // The join snapshot predates a wait for the account lock: a recovery could have deleted
    // the session meanwhile. Re-read after acquiring the lock before granting writer access.
    return findSession(tx, { ...params, lockAccount: "no lock" });
}

export function readSession(
    q: Queryable,
    params: {
        readonly token: BearerToken;
        readonly txNow: EpochMs;
        readonly purposes: readonly SessionPurpose[];
    },
): Promise<Result<BrowserSession, SessionInvalid | DbFailure>> {
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

const ListedSessionRowSchema = z.object({
    public_id: SessionId,
    purpose: z.enum(["member", "setup", "appeal"]),
    created_at: EpochMs,
    last_seen_at: EpochMs,
    expires_at: EpochMs,
    client_ip: z.string().nullable(),
    user_agent: z.string().nullable(),
});

export type ListedSession = {
    readonly sessionId: SessionId;
    readonly purpose: SessionPurpose;
    readonly createdAt: EpochMs;
    readonly lastSeenAt: EpochMs;
    readonly expiresAt: EpochMs;
    readonly client: { readonly ip: string | null; readonly userAgent: string | null };
    readonly current: boolean;
};

// The holder's own live sessions, most recently seen first. The client info is shown only here,
// to the account it belongs to.
export async function listSessions(
    db: Db,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<readonly ListedSession[], SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const rows = await queryAll(
            tx,
            ListedSessionRowSchema,
            sql`select public_id, purpose, created_at, last_seen_at, expires_at,
                       host(client_ip) as client_ip, user_agent
                from browser_session
                where account_id = ${session.value.accountId}
                  and expires_at > ${toTimestamptz(txNow)}::timestamptz
                order by last_seen_at desc, public_id`,
        );
        if (!rows.ok) return rows;
        return ok(
            rows.value.map((row) => ({
                sessionId: row.public_id,
                purpose: row.purpose,
                createdAt: row.created_at,
                lastSeenAt: row.last_seen_at,
                expiresAt: row.expires_at,
                client: { ip: row.client_ip, userAgent: row.user_agent },
                current: row.public_id === session.value.sessionId,
            })),
        );
    });
}

// Ends one of the holder's sessions by its listed id. One already gone is already ended.
export async function signOutSession(
    db: Db,
    params: { readonly sessionToken: BearerToken; readonly sessionId: SessionId },
): Promise<Result<void, SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const res = await execute(
            tx,
            sql`delete from browser_session
                where account_id = ${session.value.accountId}
                  and public_id = ${params.sessionId}`,
        );
        if (!res.ok) return res;
        return ok(undefined);
    });
}

// Refreshes when the session was last seen and from where, at most once per granularity window.
// Only the session row is locked, and nothing else is waited on while holding it, so this can't
// deadlock against a writer that locked the account first and is ending the session.
export async function touchSession(
    tx: Tx,
    params: {
        readonly tokenHash: Uint8Array;
        readonly txNow: EpochMs;
        readonly client: ClientInfo | null;
    },
): Promise<Result<void, DbFailure>> {
    const staleBefore = EpochMs.parse(Math.max(0, params.txNow - LAST_SEEN_GRANULARITY_MS));
    const res = await execute(
        tx,
        sql`update browser_session
            set last_seen_at = ${toTimestamptz(params.txNow)}::timestamptz,
                client_ip = coalesce(${params.client?.ip ?? null}::inet, client_ip),
                user_agent = coalesce(${params.client?.userAgent ?? null}, user_agent)
            where token_hash = ${params.tokenHash}
              and last_seen_at <= ${toTimestamptz(staleBefore)}::timestamptz`,
    );
    if (!res.ok) return res;
    return ok(undefined);
}
