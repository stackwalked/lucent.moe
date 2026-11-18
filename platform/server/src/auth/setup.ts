import { z } from "zod";
import { parseUsername, type UsernameInvalid } from "../authority/usernames.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { CryptoRng } from "../core/rng.ts";
import { AccountId, EpochMs } from "../core/scalars.ts";
import { appendAudit } from "../db/audit.ts";
import { type DbFailure, execute, queryOne, sql, type Tx, toTimestamptz } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { lockAccount } from "./accounts.ts";
import type { AuthDeps } from "./deps.ts";
import { lockSession, mintSession, type SessionRefusal } from "./sessions.ts";
import { type BearerToken, hashToken, issueToken } from "./tokens.ts";

// Long enough to reach someone through whatever channel staff use, short enough that a link
// found in an old chat log is dead.
const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1_000;

// Web serves a setup link at this path; ops prints it for the root account.
export function setupPath(token: BearerToken): string {
    return `/setup/${token}`;
}

// Replaces any earlier link for the account: only the newest one works.
export async function issueSetupToken(
    tx: Tx,
    params: {
        readonly rng: CryptoRng;
        readonly accountId: AccountId;
        readonly issuedBy: string;
        readonly txNow: EpochMs;
    },
): Promise<Result<BearerToken, DbFailure>> {
    const cleared = await execute(
        tx,
        sql`delete from setup_token where account_id = ${params.accountId}`,
    );
    if (!cleared.ok) return cleared;
    const issued = await issueToken(params.rng);
    const expiresAt = EpochMs.parse(params.txNow + SETUP_TOKEN_TTL_MS);
    const inserted = await execute(
        tx,
        sql`insert into setup_token (token_hash, account_id, issued_by, created_at, expires_at)
            values (${issued.hash}, ${params.accountId}, ${params.issuedBy},
                    ${toTimestamptz(params.txNow)}::timestamptz, ${toTimestamptz(expiresAt)}::timestamptz)`,
    );
    if (!inserted.ok) return inserted;
    return ok(issued.token);
}

// Recovery: every way into the account, and everyone signed in to it, is gone. The caller holds
// the account lock.
export async function clearCredentials(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<void, DbFailure>> {
    for (const statement of [
        sql`delete from passkey where account_id = ${accountId}`,
        sql`delete from password_credential where account_id = ${accountId}`,
        sql`delete from totp_credential where account_id = ${accountId}`,
        sql`delete from auth_flow where account_id = ${accountId}`,
        sql`delete from browser_session where account_id = ${accountId}`,
    ]) {
        const res = await execute(tx, statement);
        if (!res.ok) return res;
    }
    return ok(undefined);
}

export type SetupRefusal =
    | DbFailure
    | SessionRefusal
    | UsernameInvalid
    | { readonly code: "SETUP_INVALID" }
    | { readonly code: "USERNAME_ALREADY_SET" }
    | { readonly code: "USERNAME_TAKEN" };

// A setup link works once: redeeming it starts a 15-minute setup session, which can choose the
// username and enroll credentials, nothing else. The holder signs in normally afterwards.
export async function redeemSetupLink(
    deps: AuthDeps,
    params: { readonly setupToken: BearerToken },
): Promise<
    Result<
        {
            readonly sessionToken: BearerToken;
            readonly expiresAt: EpochMs;
            readonly needsUsername: boolean;
        },
        SetupRefusal
    >
> {
    const tokenHash = await hashToken(params.setupToken);
    return await withTx(deps.db, async (tx, txNow) => {
        const seen = await queryOne(
            tx,
            z.object({ account_id: AccountId }),
            sql`select account_id from setup_token
                where token_hash = ${tokenHash}
                  and expires_at > ${toTimestamptz(txNow)}::timestamptz`,
        );
        if (!seen.ok) return seen;
        if (seen.value === null) return err({ code: "SETUP_INVALID" });
        const accountId = seen.value.account_id;
        const account = await lockAccount(tx, accountId);
        if (!account.ok) return account;
        if (account.value === null || !account.value.isActive) {
            return err({ code: "SETUP_INVALID" });
        }
        const consumed = await execute(
            tx,
            sql`delete from setup_token where token_hash = ${tokenHash}`,
        );
        if (!consumed.ok) return consumed;
        if (consumed.value === 0) return err({ code: "SETUP_INVALID" });
        const session = await mintSession(tx, {
            rng: deps.rng,
            accountId,
            purpose: "setup",
            txNow,
        });
        if (!session.ok) return session;
        return ok({
            sessionToken: session.value.token,
            expiresAt: session.value.expiresAt,
            needsUsername: account.value.username === null,
        });
    });
}

export async function chooseUsername(
    deps: AuthDeps,
    params: { readonly sessionToken: BearerToken; readonly username: string },
): Promise<Result<{ readonly username: string }, SetupRefusal>> {
    const parsed = parseUsername(params.username);
    if (!parsed.ok) return parsed;
    return await withTx(deps.db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["setup"],
        });
        if (!session.ok) return session;
        const accountId = session.value.accountId;
        const account = await lockAccount(tx, accountId);
        if (!account.ok) return account;
        if (account.value?.username !== null) return err({ code: "USERNAME_ALREADY_SET" });

        const claimed = await execute(
            tx,
            sql`insert into username_claim (skeleton, username, account_id, claimed_at)
                values (${parsed.value.skeleton}, ${parsed.value.username}, ${accountId},
                        ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!claimed.ok) {
            if (claimed.error.code === "UNIQUE_VIOLATION") return err({ code: "USERNAME_TAKEN" });
            return claimed;
        }
        const named = await execute(
            tx,
            sql`update account set username = ${parsed.value.username} where id = ${accountId}`,
        );
        if (!named.ok) {
            if (named.error.code === "UNIQUE_VIOLATION") return err({ code: "USERNAME_TAKEN" });
            return named;
        }
        const audited = await appendAudit(tx, {
            actorId: accountId,
            operation: "account.username_chosen",
            target: { accountId, username: parsed.value.username },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ username: parsed.value.username });
    });
}
