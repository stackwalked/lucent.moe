import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import {
    type AccountId,
    type BearerToken,
    type ClientInfo,
    EpochMs,
    toBase64Url,
} from "@lucent/core/scalars";
import type { AuditOperation } from "@lucent/policy/operations";
import type {
    AuthenticationResponse,
    CreationOptions,
    RegistrationResponse,
    RequestOptions,
} from "@lucent/rpc/webauthn";
import { z } from "zod";
import { appendAudit } from "../db/audit.ts";
import { type DbFailure, execute, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { errCommit, withTx } from "../db/tx.ts";
import { findPasskey, lockAccount, readPasskeys } from "./accounts.ts";
import type { AuthDeps } from "./deps.ts";
import { endFlow, type FlowRefusal, lockFlow, startFlow } from "./flows.ts";
import {
    authenticationOptions,
    type PasskeyRefusal,
    rawIdOf,
    registrationOptions,
    verifyAssertion,
    verifyRegistration,
} from "./passkeys.ts";
import { type PasswordRejected, prepareNewPassword } from "./password.ts";
import {
    type BrowserSession,
    endOtherSessions,
    lockSession,
    readSession,
    requireFresh,
    type SessionRefusal,
} from "./sessions.ts";
import { newChallenge } from "./sign-in.ts";
import { hashToken } from "./tokens.ts";
import { matchTotpCode, newTotpSecret, openTotpSecret, sealTotpSecret, totpUri } from "./totp.ts";

const TOTP_ISSUER = "lucent.moe";

export type CredentialRefusal =
    | DbFailure
    | SessionRefusal
    | FlowRefusal
    | PasskeyRefusal
    | PasswordRejected
    // In a known data breach (auth/breach.ts).
    | { readonly code: "PASSWORD_BREACHED" }
    | { readonly code: "NOT_FOUND" }
    // Removing it would leave the account with no way to sign in.
    | { readonly code: "LAST_CREDENTIAL" }
    | { readonly code: "USERNAME_REQUIRED" }
    | { readonly code: "TOTP_ALREADY_ENROLLED" }
    | { readonly code: "TOTP_NOT_PENDING" }
    | { readonly code: "TOTP_CODE_INVALID" }
    | { readonly code: "NO_PASSKEY" };

type CredentialChange = {
    readonly session: BrowserSession;
    readonly username: string | null;
};

// Every credential change starts here: the session's account is locked and its holder must have
// proven a factor recently (or be in setup).
async function beginCredentialChange(
    tx: Tx,
    params: { readonly sessionToken: BearerToken; readonly txNow: EpochMs },
): Promise<Result<CredentialChange, CredentialRefusal>> {
    const session = await lockSession(tx, {
        token: params.sessionToken,
        txNow: params.txNow,
        purposes: ["member", "setup"],
    });
    if (!session.ok) return session;
    const fresh = requireFresh(session.value, params.txNow);
    if (!fresh.ok) return fresh;
    const account = await lockAccount(tx, session.value.accountId);
    if (!account.ok) return account;
    invariant(account.value !== null, "a resolved session's account exists");
    return ok({ session: session.value, username: account.value.username });
}

// A credential changed: anyone signed in with the old set is signed out, except this session.
async function finishCredentialChange(
    tx: Tx,
    params: {
        readonly change: CredentialChange;
        readonly operation: AuditOperation;
        readonly detail: Record<string, unknown>;
        readonly txNow: EpochMs;
        readonly client: ClientInfo | undefined;
    },
): Promise<Result<void, DbFailure>> {
    const { accountId, tokenHash } = params.change.session;
    const ended = await endOtherSessions(tx, { accountId, keep: tokenHash });
    if (!ended.ok) return ended;
    return await appendAudit(tx, {
        actorId: accountId,
        operation: params.operation,
        target: { accountId, ...params.detail },
        at: params.txNow,
        client: params.client ?? null,
    });
}

const SignInPathsRowSchema = z.object({
    passkeys: z.coerce.number().int(),
    password: z.boolean(),
    totp: z.boolean(),
});

type SignInPaths = z.output<typeof SignInPathsRowSchema>;

function canSignIn(paths: SignInPaths): boolean {
    return paths.passkeys > 0 || (paths.password && paths.totp);
}

async function readSignInPaths(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<SignInPaths, DbFailure>> {
    const row = await queryOne(
        tx,
        SignInPathsRowSchema,
        sql`select
                (select count(*) from passkey where account_id = ${accountId}) as passkeys,
                exists (select 1 from password_credential where account_id = ${accountId}) as password,
                exists (select 1 from totp_credential
                        where account_id = ${accountId} and confirmed) as totp`,
    );
    if (!row.ok) return row;
    invariant(row.value !== null, "an aggregate select returns a row");
    return ok(row.value);
}

const Bytes = z.instanceof(Uint8Array);

const PasskeyListRowSchema = z.object({
    id: Bytes,
    label: z.string(),
    backed_up: z.boolean(),
    created_at: EpochMs,
    last_used_at: EpochMs.nullable(),
});

export type CredentialList = {
    readonly passkeys: readonly {
        readonly id: string;
        readonly label: string;
        readonly backedUp: boolean;
        readonly createdAt: EpochMs;
        readonly lastUsedAt: EpochMs | null;
    }[];
    readonly password: { readonly updatedAt: EpochMs } | null;
    readonly totp: { readonly confirmed: boolean } | null;
};

export async function listCredentials(
    deps: AuthDeps,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<CredentialList, CredentialRefusal>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member", "setup"],
        });
        if (!session.ok) return session;
        const accountId = session.value.accountId;
        const passkeys = await queryAll(
            tx,
            PasskeyListRowSchema,
            sql`select id, label, backed_up, created_at, last_used_at from passkey
                where account_id = ${accountId} order by created_at, id`,
        );
        if (!passkeys.ok) return passkeys;
        const password = await queryOne(
            tx,
            z.object({ updated_at: EpochMs }),
            sql`select updated_at from password_credential where account_id = ${accountId}`,
        );
        if (!password.ok) return password;
        const totp = await queryOne(
            tx,
            z.object({ confirmed: z.boolean() }),
            sql`select confirmed from totp_credential where account_id = ${accountId}`,
        );
        if (!totp.ok) return totp;
        return ok({
            passkeys: passkeys.value.map((row) => ({
                id: toBase64Url(row.id),
                label: row.label,
                backedUp: row.backed_up,
                createdAt: row.created_at,
                lastUsedAt: row.last_used_at,
            })),
            password: password.value === null ? null : { updatedAt: password.value.updated_at },
            totp: totp.value,
        });
    });
}

export async function setPassword(
    deps: AuthDeps,
    params: {
        readonly sessionToken: BearerToken;
        readonly password: string;
        readonly client?: ClientInfo;
    },
): Promise<Result<void, CredentialRefusal>> {
    const prepared = await prepareNewPassword(deps, params.password);
    if (!prepared.ok) return prepared;
    const hash = prepared.value;
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const stored = await execute(
            tx,
            sql`insert into password_credential (account_id, hash, updated_at)
                values (${change.value.session.accountId}, ${hash}, now())
                on conflict (account_id) do update set hash = excluded.hash, updated_at = now()`,
        );
        if (!stored.ok) return stored;
        // A reset link asked for before this change would still set another password; its queued
        // mail goes with it.
        const unlinked = await execute(
            tx,
            sql`delete from password_reset where account_id = ${change.value.session.accountId}`,
        );
        if (!unlinked.ok) return unlinked;
        return await finishCredentialChange(tx, {
            change: change.value,
            operation: "credential.password_set",
            detail: {},
            txNow,
            client: params.client,
        });
    });
}

// The secret is shown once, as a QR code's URI and as text; it's stored unconfirmed until a code
// from it proves the authenticator app holds it.
export async function beginTotpEnrollment(
    deps: AuthDeps,
    params: { readonly sessionToken: BearerToken },
): Promise<Result<{ readonly uri: string; readonly secret: string }, CredentialRefusal>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const username = change.value.username;
        if (username === null) return err({ code: "USERNAME_REQUIRED" });
        const accountId = change.value.session.accountId;
        const existing = await queryOne(
            tx,
            z.object({ confirmed: z.boolean() }),
            sql`select confirmed from totp_credential where account_id = ${accountId}`,
        );
        if (!existing.ok) return existing;
        if (existing.value?.confirmed === true) return err({ code: "TOTP_ALREADY_ENROLLED" });

        const secret = newTotpSecret(deps.rng);
        const sealed = await sealTotpSecret({
            keyring: deps.totpKeys,
            rng: deps.rng,
            accountId,
            secret,
        });
        const stored = await execute(
            tx,
            sql`insert into totp_credential (account_id, key_id, secret_sealed, created_at)
                values (${accountId}, ${sealed.kid}, ${sealed.sealed}, now())
                on conflict (account_id) do update
                    set key_id = excluded.key_id, secret_sealed = excluded.secret_sealed,
                        created_at = excluded.created_at, last_used_step = 0`,
        );
        if (!stored.ok) return stored;
        const uri = totpUri({ issuer: TOTP_ISSUER, username, secret });
        const text = new URL(uri).searchParams.get("secret") ?? "";
        return ok({ uri, secret: text });
    });
}

export async function confirmTotpEnrollment(
    deps: AuthDeps,
    params: {
        readonly sessionToken: BearerToken;
        readonly code: string;
        readonly client?: ClientInfo;
    },
): Promise<Result<void, CredentialRefusal>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const accountId = change.value.session.accountId;
        const pending = await queryOne(
            tx,
            z.object({ key_id: z.string(), secret_sealed: Bytes }),
            sql`select key_id, secret_sealed from totp_credential
                where account_id = ${accountId} and not confirmed`,
        );
        if (!pending.ok) return pending;
        if (pending.value === null) return err({ code: "TOTP_NOT_PENDING" });
        const secret = await openTotpSecret({
            keyring: deps.totpKeys,
            accountId,
            sealed: { kid: pending.value.key_id, sealed: pending.value.secret_sealed },
        });
        invariant(secret.ok, `pending TOTP secret of ${accountId} won't open`);
        const step = await matchTotpCode({
            secret: secret.value,
            code: params.code,
            at: txNow,
            lastUsedStep: 0,
        });
        if (step === null) return err({ code: "TOTP_CODE_INVALID" });
        const confirmed = await execute(
            tx,
            sql`update totp_credential set confirmed = true, last_used_step = ${step}
                where account_id = ${accountId}`,
        );
        if (!confirmed.ok) return confirmed;
        return await finishCredentialChange(tx, {
            change: change.value,
            operation: "credential.totp_enrolled",
            detail: {},
            txNow,
            client: params.client,
        });
    });
}

export async function beginPasskeyRegistration(
    deps: AuthDeps,
    params: { readonly sessionToken: BearerToken },
): Promise<
    Result<
        {
            readonly flowToken: BearerToken;
            readonly options: CreationOptions;
        },
        CredentialRefusal
    >
> {
    const challenge = newChallenge(deps);
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const username = change.value.username;
        if (username === null) return err({ code: "USERNAME_REQUIRED" });
        const { accountId, tokenHash } = change.value.session;
        const existing = await readPasskeys(tx, accountId);
        if (!existing.ok) return existing;
        const flowToken = await startFlow(tx, {
            rng: deps.rng,
            kind: "register",
            accountId,
            sessionHash: tokenHash,
            passwordOk: "no password",
            challenge,
            txNow,
        });
        if (!flowToken.ok) return flowToken;
        const options = await registrationOptions({
            rp: deps.rp,
            challenge,
            accountId,
            username,
            existing: existing.value,
        });
        return ok({ flowToken: flowToken.value, options });
    });
}

export async function finishPasskeyRegistration(
    deps: AuthDeps,
    params: {
        readonly sessionToken: BearerToken;
        readonly flowToken: BearerToken;
        readonly label: string;
        readonly response: RegistrationResponse;
        readonly client?: ClientInfo;
    },
): Promise<Result<{ readonly id: string }, CredentialRefusal>> {
    const flowHash = await hashToken(params.flowToken);
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const flow = await lockFlow(tx, { tokenHash: flowHash, kind: "register", txNow });
        if (!flow.ok) return flow;
        const { accountId, tokenHash } = change.value.session;
        const challenge = flow.value.challenge;
        if (!sameBytes(flow.value.sessionHash, tokenHash) || challenge === null) {
            return err({ code: "FLOW_INVALID" });
        }
        const ended = await endFlow(tx, flowHash);
        if (!ended.ok) return ended;
        const registered = await verifyRegistration({
            rp: deps.rp,
            challenge,
            response: params.response,
        });
        // The challenge is spent either way: committed with the refusal.
        if (!registered.ok) return errCommit(registered.error);

        const passkey = registered.value;
        const stored = await execute(
            tx,
            sql`insert into passkey (id, account_id, public_key, sign_count, transports, backed_up,
                                     label, created_at)
                values (${passkey.id}, ${accountId}, ${passkey.publicKey}, ${passkey.signCount},
                        ${[...passkey.transports]}, ${passkey.backedUp}, ${params.label}, now())`,
        );
        if (!stored.ok) {
            // The same authenticator registered twice, here or on another account.
            if (stored.error.code === "UNIQUE_VIOLATION") return err({ code: "PASSKEY_REJECTED" });
            return stored;
        }
        const id = toBase64Url(passkey.id);
        const finished = await finishCredentialChange(tx, {
            change: change.value,
            operation: "credential.passkey_added",
            detail: { passkeyId: id },
            txNow,
            client: params.client,
        });
        if (!finished.ok) return finished;
        return ok({ id });
    });
}

export type CredentialRef =
    | { readonly kind: "passkey"; readonly id: Uint8Array }
    | { readonly kind: "password" }
    | { readonly kind: "totp" };

const REMOVED = {
    passkey: "credential.passkey_removed",
    password: "credential.password_removed",
    totp: "credential.totp_removed",
} as const satisfies Record<CredentialRef["kind"], AuditOperation>;

// Never leaves the account without a way in. The account lock serializes removals, so two
// removals that would each be fine alone can't together strand it.
export async function removeCredential(
    deps: AuthDeps,
    params: {
        readonly sessionToken: BearerToken;
        readonly credential: CredentialRef;
        readonly client?: ClientInfo;
    },
): Promise<Result<void, CredentialRefusal>> {
    return await withTx(deps.db, async (tx, txNow) => {
        const change = await beginCredentialChange(tx, {
            sessionToken: params.sessionToken,
            txNow,
        });
        if (!change.ok) return change;
        const accountId = change.value.session.accountId;
        const paths = await readSignInPaths(tx, accountId);
        if (!paths.ok) return paths;

        const credential = params.credential;
        const remove =
            credential.kind === "passkey"
                ? sql`delete from passkey where account_id = ${accountId} and id = ${credential.id}`
                : credential.kind === "password"
                  ? sql`delete from password_credential where account_id = ${accountId}`
                  : sql`delete from totp_credential where account_id = ${accountId}`;
        const removed = await execute(tx, remove);
        if (!removed.ok) return removed;
        if (removed.value === 0) return err({ code: "NOT_FOUND" });

        const after = await readSignInPaths(tx, accountId);
        if (!after.ok) return after;
        // An account still being set up has no path yet; only a working one can be stranded.
        if (canSignIn(paths.value) && !canSignIn(after.value)) {
            return err({ code: "LAST_CREDENTIAL" });
        }
        return await finishCredentialChange(tx, {
            change: change.value,
            operation: REMOVED[credential.kind],
            detail: credential.kind === "passkey" ? { passkeyId: toBase64Url(credential.id) } : {},
            txNow,
            client: params.client,
        });
    });
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
    if (left === null || left.byteLength !== right.byteLength) return false;
    return left.every((byte, i) => byte === right[i]);
}

// Step-up is passkey-only: a fresh user-verified assertion, not a password a phishing page could
// have relayed.
export async function beginStepUp(
    deps: AuthDeps,
    params: { readonly sessionToken: BearerToken },
): Promise<
    Result<
        {
            readonly flowToken: BearerToken;
            readonly options: RequestOptions;
        },
        CredentialRefusal
    >
> {
    const challenge = newChallenge(deps);
    return await withTx(deps.db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const { accountId, tokenHash } = session.value;
        const passkeys = await readPasskeys(tx, accountId);
        if (!passkeys.ok) return passkeys;
        if (passkeys.value.length === 0) return err({ code: "NO_PASSKEY" });
        const flowToken = await startFlow(tx, {
            rng: deps.rng,
            kind: "step_up",
            accountId,
            sessionHash: tokenHash,
            passwordOk: "no password",
            challenge,
            txNow,
        });
        if (!flowToken.ok) return flowToken;
        const options = await authenticationOptions({
            rp: deps.rp,
            challenge,
            allow: passkeys.value,
        });
        return ok({ flowToken: flowToken.value, options });
    });
}

export async function finishStepUp(
    deps: AuthDeps,
    params: {
        readonly sessionToken: BearerToken;
        readonly flowToken: BearerToken;
        readonly response: AuthenticationResponse;
    },
): Promise<Result<{ readonly stepUpAt: EpochMs }, CredentialRefusal>> {
    const flowHash = await hashToken(params.flowToken);
    return await withTx(deps.db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const { accountId, tokenHash } = session.value;
        const flow = await lockFlow(tx, { tokenHash: flowHash, kind: "step_up", txNow });
        if (!flow.ok) return flow;
        const challenge = flow.value.challenge;
        if (!sameBytes(flow.value.sessionHash, tokenHash) || challenge === null) {
            return err({ code: "FLOW_INVALID" });
        }
        const ended = await endFlow(tx, flowHash);
        if (!ended.ok) return ended;

        const passkey = await findPasskey(tx, rawIdOf(params.response));
        if (!passkey.ok) return passkey;
        if (passkey.value === null || passkey.value.accountId !== accountId) {
            return errCommit({ code: "PASSKEY_REJECTED" as const });
        }
        const verified = await verifyAssertion({
            rp: deps.rp,
            challenge,
            response: params.response,
            passkey: passkey.value,
        });
        if (!verified.ok) return errCommit(verified.error);
        const used = await execute(
            tx,
            sql`update passkey set sign_count = ${verified.value.signCount}, last_used_at = now()
                where id = ${passkey.value.id}`,
        );
        if (!used.ok) return used;
        const stepped = await execute(
            tx,
            sql`update browser_session set step_up_at = now() where token_hash = ${tokenHash}`,
        );
        if (!stepped.ok) return stepped;
        return ok({ stepUpAt: txNow });
    });
}
