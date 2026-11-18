import { z } from "zod";
import type { AuthenticationResponse, RequestOptions } from "../contract/webauthn.ts";
import { invariant } from "../core/contain.ts";
import { err, ok, type Result } from "../core/result.ts";
import { AccountId, type BearerToken, type EpochMs } from "../core/scalars.ts";
import { type DbFailure, execute, queryOne, sql, type Tx } from "../db/pool.ts";
import { errCommit, withTx } from "../db/tx.ts";
import { findPasskey, lockAccount, readPasskeys } from "./accounts.ts";
import type { AuthDeps } from "./deps.ts";
import {
    endFlow,
    type FlowRefusal,
    failFlow,
    lockFlow,
    readFlow,
    setFlowChallenge,
    startFlow,
} from "./flows.ts";
import {
    authenticationOptions,
    type PasskeyRefusal,
    rawIdOf,
    verifyAssertion,
} from "./passkeys.ts";
import { normalizePasswordAttempt } from "./password.ts";
import { mintSession } from "./sessions.ts";
import { hashToken } from "./tokens.ts";
import { matchTotpCode, openTotpSecret } from "./totp.ts";

export type SignedIn = {
    readonly sessionToken: BearerToken;
    readonly expiresAt: EpochMs;
};

export type SecondFactor = "totp" | "passkey";

export type SignInRefusal =
    | DbFailure
    | FlowRefusal
    | PasskeyRefusal
    // Wrong username, wrong password, wrong code: one answer, so none of them says which.
    | { readonly code: "INVALID_CREDENTIALS" }
    // After every factor passed: the account is suspended or locked.
    | { readonly code: "ACCOUNT_UNAVAILABLE" }
    // The password was right but the account has nothing to finish with; setup was abandoned.
    | { readonly code: "NO_SECOND_FACTOR" };

const PasswordRowSchema = z.object({
    id: AccountId,
    hash: z.string().nullable(),
});

const FactorRowSchema = z.object({
    totp: z.boolean(),
    passkeys: z.boolean(),
});

const TotpRowSchema = z.object({
    key_id: z.string(),
    secret_sealed: z.instanceof(Uint8Array),
    last_used_step: z.coerce.number().int().nonnegative(),
});

const CHALLENGE_BYTES = 32;

export function newChallenge(deps: AuthDeps): Uint8Array {
    return deps.rng.fillBytes(new Uint8Array(CHALLENGE_BYTES));
}

// Every factor passed: the account must still be usable, and a member session starts.
async function finishSignIn(
    tx: Tx,
    deps: AuthDeps,
    params: { readonly accountId: AccountId; readonly txNow: EpochMs },
): Promise<Result<SignedIn, SignInRefusal>> {
    const account = await lockAccount(tx, params.accountId);
    if (!account.ok) return account;
    if (account.value === null || !account.value.isActive) {
        return err({ code: "ACCOUNT_UNAVAILABLE" });
    }
    const session = await mintSession(tx, {
        rng: deps.rng,
        accountId: params.accountId,
        purpose: "member",
        txNow: params.txNow,
    });
    if (!session.ok) return session;
    return ok({ sessionToken: session.value.token, expiresAt: session.value.expiresAt });
}

// A password is a first factor only: it opens a flow that a TOTP code or a passkey finishes.
export async function signInWithPassword(
    deps: AuthDeps,
    params: { readonly username: string; readonly password: string },
): Promise<
    Result<
        { readonly flowToken: BearerToken; readonly secondFactors: readonly SecondFactor[] },
        SignInRefusal
    >
> {
    const username = params.username.trim().toLowerCase();
    // Read and verified outside any transaction: argon2id would hold a connection meanwhile.
    const row = await queryOne(
        deps.db,
        PasswordRowSchema,
        sql`select a.id, p.hash from account a
            left join password_credential p on p.account_id = a.id
            where a.username = ${username}`,
    );
    if (!row.ok) return row;
    const verified = await deps.verifyPassword(
        normalizePasswordAttempt(params.password),
        row.value?.hash ?? null,
    );
    const found = row.value;
    if (!verified || found === null) return err({ code: "INVALID_CREDENTIALS" });

    return await withTx(deps.db, async (tx, txNow) => {
        const factors = await queryOne(
            tx,
            FactorRowSchema,
            sql`select
                    exists (select 1 from totp_credential
                            where account_id = ${found.id} and confirmed) as totp,
                    exists (select 1 from passkey where account_id = ${found.id}) as passkeys`,
        );
        if (!factors.ok) return factors;
        const secondFactors: SecondFactor[] = [];
        if (factors.value?.totp === true) secondFactors.push("totp");
        if (factors.value?.passkeys === true) secondFactors.push("passkey");
        if (secondFactors.length === 0) return err({ code: "NO_SECOND_FACTOR" as const });

        const flowToken = await startFlow(tx, {
            rng: deps.rng,
            kind: "sign_in",
            accountId: found.id,
            sessionHash: null,
            passwordOk: "password verified",
            challenge: null,
            txNow,
        });
        if (!flowToken.ok) return flowToken;
        return ok({ flowToken: flowToken.value, secondFactors });
    });
}

export async function signInWithTotp(
    deps: AuthDeps,
    params: { readonly flowToken: BearerToken; readonly code: string },
): Promise<Result<SignedIn, SignInRefusal>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const seen = await readFlow(tx, { token: params.flowToken, kind: "sign_in", txNow });
        if (!seen.ok) return seen;
        const accountId = seen.value.accountId;
        if (accountId === null || !seen.value.passwordOk) return err({ code: "FLOW_INVALID" });
        const account = await lockAccount(tx, accountId);
        if (!account.ok) return account;
        const flow = await lockFlow(tx, {
            tokenHash: seen.value.tokenHash,
            kind: "sign_in",
            txNow,
        });
        if (!flow.ok) return flow;

        const totp = await queryOne(
            tx,
            TotpRowSchema,
            sql`select key_id, secret_sealed, last_used_step from totp_credential
                where account_id = ${accountId} and confirmed`,
        );
        if (!totp.ok) return totp;
        if (totp.value === null) return err({ code: "INVALID_CREDENTIALS" });
        const secret = await openTotpSecret({
            keyring: deps.totpKeys,
            accountId,
            sealed: { kid: totp.value.key_id, sealed: totp.value.secret_sealed },
        });
        // Sealed by this server under a key it no longer holds: the keyring config lost a key.
        invariant(
            secret.ok,
            `TOTP secret of ${accountId} won't open under key ${totp.value.key_id}`,
        );
        const step = await matchTotpCode({
            secret: secret.value,
            code: params.code,
            at: txNow,
            lastUsedStep: totp.value.last_used_step,
        });
        if (step === null) {
            const failed = await failFlow(tx, flow.value);
            if (!failed.ok) return failed;
            return errCommit({ code: "INVALID_CREDENTIALS" as const });
        }

        const used = await execute(
            tx,
            sql`update totp_credential set last_used_step = ${step} where account_id = ${accountId}`,
        );
        if (!used.ok) return used;
        const ended = await endFlow(tx, flow.value.tokenHash);
        if (!ended.ok) return ended;
        return await finishSignIn(tx, deps, { accountId, txNow });
    });
}

// Without a flow token this starts a passkey-only sign-in: the browser offers any discoverable
// passkey for the site. With one, the passkey is the second factor after a password.
export async function beginPasskeySignIn(
    deps: AuthDeps,
    params: { readonly flowToken: BearerToken | null },
): Promise<
    Result<
        {
            readonly flowToken: BearerToken;
            readonly options: RequestOptions;
        },
        SignInRefusal
    >
> {
    const challenge = newChallenge(deps);
    return await withTx(deps.db, async (tx, txNow) => {
        if (params.flowToken === null) {
            const flowToken = await startFlow(tx, {
                rng: deps.rng,
                kind: "sign_in",
                accountId: null,
                sessionHash: null,
                passwordOk: "no password",
                challenge,
                txNow,
            });
            if (!flowToken.ok) return flowToken;
            const options = await authenticationOptions({ rp: deps.rp, challenge, allow: [] });
            return ok({ flowToken: flowToken.value, options });
        }

        const seen = await readFlow(tx, { token: params.flowToken, kind: "sign_in", txNow });
        if (!seen.ok) return seen;
        const accountId = seen.value.accountId;
        if (accountId === null || !seen.value.passwordOk) return err({ code: "FLOW_INVALID" });
        const account = await lockAccount(tx, accountId);
        if (!account.ok) return account;
        const flow = await lockFlow(tx, {
            tokenHash: seen.value.tokenHash,
            kind: "sign_in",
            txNow,
        });
        if (!flow.ok) return flow;
        const passkeys = await readPasskeys(tx, accountId);
        if (!passkeys.ok) return passkeys;
        if (passkeys.value.length === 0) return err({ code: "NO_SECOND_FACTOR" });
        const set = await setFlowChallenge(tx, flow.value.tokenHash, challenge);
        if (!set.ok) return set;
        const options = await authenticationOptions({
            rp: deps.rp,
            challenge,
            allow: passkeys.value,
        });
        return ok({ flowToken: params.flowToken, options });
    });
}

export async function finishPasskeySignIn(
    deps: AuthDeps,
    params: {
        readonly flowToken: BearerToken;
        readonly response: AuthenticationResponse;
    },
): Promise<Result<SignedIn, SignInRefusal>> {
    const tokenHash = await hashToken(params.flowToken);
    return await withTx(deps.db, async (tx, txNow) => {
        const passkey = await findPasskey(tx, rawIdOf(params.response));
        if (!passkey.ok) return passkey;
        const accountId = passkey.value?.accountId ?? null;
        if (accountId !== null) {
            const account = await lockAccount(tx, accountId);
            if (!account.ok) return account;
        }
        const flow = await lockFlow(tx, { tokenHash, kind: "sign_in", txNow });
        if (!flow.ok) return flow;
        const challenge = flow.value.challenge;
        if (challenge === null) return err({ code: "FLOW_INVALID" });

        // A password flow belongs to one account; its passkey must be that account's.
        const belongs =
            passkey.value !== null &&
            (flow.value.accountId === null || flow.value.accountId === accountId);
        const verified =
            passkey.value !== null && belongs
                ? await verifyAssertion({
                      rp: deps.rp,
                      challenge,
                      response: params.response,
                      passkey: passkey.value,
                  })
                : err<PasskeyRefusal>({ code: "PASSKEY_REJECTED" });
        if (!verified.ok || accountId === null) {
            // Each challenge answers once. A password flow keeps its count; a passkey-only one
            // has nothing worth keeping and ends.
            const failed = flow.value.passwordOk
                ? await failFlow(tx, flow.value)
                : await endFlow(tx, tokenHash);
            if (!failed.ok) return failed;
            return errCommit({ code: "PASSKEY_REJECTED" as const });
        }

        const used = await execute(
            tx,
            sql`update passkey set sign_count = ${verified.value.signCount}, last_used_at = now()
                where id = ${passkey.value?.id ?? null}`,
        );
        if (!used.ok) return used;
        const ended = await endFlow(tx, tokenHash);
        if (!ended.ok) return ended;
        return await finishSignIn(tx, deps, { accountId, txNow });
    });
}
