import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import {
    AccountId,
    BearerToken,
    EpochMs,
    sha256Base64Url,
    toBase64Url,
} from "@lucent/core/scalars";
import { z } from "zod";
import { lockSession, readSession, type SessionInvalid } from "../auth/sessions.ts";
import { hashToken, issueToken } from "../auth/tokens.ts";
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
import { errCommit, withTx } from "../db/tx.ts";
import { lockActiveAccount } from "./accounts.ts";
import type { DpopProof } from "./dpop.ts";
import { matchCodeOf, newWireId } from "./ids.ts";

// The loader's sign-in (OAuth 2.0 for a native app, RFC 8252): it pushes its request (RFC 9126)
// with a DPoP proof by the device key, opens the member's browser at
// `<web origin>/auth/device/<request id>`, where web asks the member to approve, and receives the
// code on its loopback listener. The code, redeemed with the PKCE verifier and the same key, buys
// a refresh token that rotates on every use and short access tokens, all bound to that key.
// OAuth's own endpoints stay standard (form bodies, JSON replies), as the native contract decided.

export const LOADER_CLIENT_ID = "lucent-loader";

const REQUEST_TTL_MS = 10 * 60 * 1_000;
const CODE_TTL_MS = 60 * 1_000;
export const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
// A refresh whose reply was lost may be retried with the same token this long after it rotated;
// later, the same token is a copy in someone else's hands, and the whole family is revoked.
export const REFRESH_RETRY_GRACE_MS = 30 * 1_000;

const REQUEST_URI_PREFIX = "urn:ietf:params:oauth:request_uri:";

export const SignInRequestId = z
    .string()
    .regex(/^lauth_[A-Za-z0-9_-]{22}$/)
    .brand<"SignInRequestId">();
export type SignInRequestId = z.output<typeof SignInRequestId>;

export type OAuthErrorCode =
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unsupported_grant_type"
    | "unsupported_response_type"
    | "invalid_dpop_proof";

export type OAuthError = { readonly code: OAuthErrorCode };

const oauthError = (code: OAuthErrorCode): Result<never, OAuthError> => err({ code });

export type TokenSet = {
    readonly accessToken: BearerToken;
    readonly refreshToken: BearerToken;
    readonly expiresInSeconds: number;
};

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;

// RFC 8252 §7.3: the loopback IP literal, never `localhost`, on a port the loader picked.
function isLoopbackRedirect(uri: string): boolean {
    const match = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/.exec(uri);
    const port = Number(match?.[1] ?? 0);
    return port >= 1_024 && port <= 65_535;
}

// Parameters the loader sends, each once; nothing else is accepted.
export function parseForm(
    body: Uint8Array,
    allowed: readonly string[],
): ReadonlyMap<string, string> | null {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
    const params = new URLSearchParams(text);
    const seen = new Map<string, string>();
    for (const [name, value] of params) {
        if (!allowed.includes(name) || seen.has(name)) return null;
        seen.set(name, value);
    }
    return seen;
}

export type PushedRequest = { readonly requestUri: string; readonly expiresInSeconds: number };

export async function pushAuthRequest(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly proof: DpopProof;
        readonly form: ReadonlyMap<string, string>;
    },
): Promise<Result<PushedRequest, OAuthError | DbFailure>> {
    const { form } = params;
    if (form.get("client_id") !== LOADER_CLIENT_ID) return oauthError("invalid_client");
    if (form.get("response_type") !== "code") return oauthError("unsupported_response_type");
    const redirectUri = form.get("redirect_uri") ?? "";
    const challenge = form.get("code_challenge") ?? "";
    const state = form.get("state") ?? "";
    if (
        form.get("code_challenge_method") !== "S256" ||
        !CHALLENGE.test(challenge) ||
        !STATE.test(state) ||
        !isLoopbackRedirect(redirectUri)
    ) {
        return oauthError("invalid_request");
    }
    const id = SignInRequestId.parse(
        `lauth_${toBase64Url(params.rng.fillBytes(new Uint8Array(16)))}`,
    );
    const created = await withTx(db, async (tx, txNow) => {
        const inserted = await execute(
            tx,
            sql`insert into native_auth_request
                    (id, jkt, redirect_uri, code_challenge, state, created_at, expires_at)
                values (${id}, ${params.proof.jkt}, ${redirectUri}, ${challenge}, ${state},
                        ${toTimestamptz(txNow)}::timestamptz,
                        ${toTimestamptz(EpochMs.parse(txNow + REQUEST_TTL_MS))}::timestamptz)`,
        );
        if (!inserted.ok) return inserted;
        return ok(undefined);
    });
    if (!created.ok) return created;
    return ok({
        requestUri: `${REQUEST_URI_PREFIX}${id}`,
        expiresInSeconds: REQUEST_TTL_MS / 1_000,
    });
}

const RequestRowSchema = z.object({
    jkt: z.string(),
    redirect_uri: z.string(),
    code_challenge: z.string(),
    state: z.string(),
    expires_at: EpochMs,
    account_id: AccountId.nullable(),
    decision: z.enum(["approved", "denied"]).nullable(),
    code_expires_at: EpochMs.nullable(),
    redeemed_at: EpochMs.nullable(),
    family_id: z.instanceof(Uint8Array).nullable(),
});

type NotFound = { readonly code: "NOT_FOUND" };

// Pending and in time: what the browser may still decide.
async function findPendingRequest(
    q: Queryable,
    params: {
        readonly id: SignInRequestId;
        readonly txNow: EpochMs;
        readonly lock: "for update" | "no lock";
    },
): Promise<Result<z.output<typeof RequestRowSchema>, NotFound | DbFailure>> {
    const row = await queryOne(
        q,
        RequestRowSchema,
        sql`select jkt, redirect_uri, code_challenge, state, expires_at, account_id, decision,
                   code_expires_at, redeemed_at, family_id
            from native_auth_request where id = ${params.id}
            ${params.lock === "for update" ? sql`for update` : sql``}`,
    );
    if (!row.ok) return row;
    if (row.value === null || row.value.decision !== null || row.value.expires_at <= params.txNow) {
        return err({ code: "NOT_FOUND" });
    }
    return ok(row.value);
}

export type SignInRequestView = {
    readonly requestId: SignInRequestId;
    readonly matchCode: string;
    readonly expiresAt: EpochMs;
};

// What web shows before the member approves: the code the loader shows too.
export async function readSignInRequest(
    db: Db,
    params: { readonly sessionToken: BearerToken; readonly requestId: SignInRequestId },
): Promise<Result<SignInRequestView, SessionInvalid | NotFound | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const request = await findPendingRequest(tx, {
            id: params.requestId,
            txNow,
            lock: "no lock",
        });
        if (!request.ok) return request;
        return ok({
            requestId: params.requestId,
            matchCode: matchCodeOf(request.value.jkt),
            expiresAt: request.value.expires_at,
        });
    });
}

export type SignInDecision = "approve" | "deny";

// Where web sends the browser next: the loader's loopback listener, with the code or the refusal
// (RFC 6749 §4.1.2). The code reaches only a listener on the PC whose browser approved, so a link
// sent to a member by someone else hands that someone nothing.
export async function decideSignInRequest(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly sessionToken: BearerToken;
        readonly requestId: SignInRequestId;
        readonly decision: SignInDecision;
    },
): Promise<Result<{ readonly redirectTo: string }, SessionInvalid | NotFound | DbFailure>> {
    const code = await issueToken(params.rng);
    return await withTx(db, async (tx, txNow) => {
        const session = await lockSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const request = await findPendingRequest(tx, {
            id: params.requestId,
            txNow,
            lock: "for update",
        });
        if (!request.ok) return request;
        const { redirect_uri: redirectUri, state } = request.value;
        const approved = params.decision === "approve";
        const updated = await execute(
            tx,
            sql`update native_auth_request
                set account_id = ${session.value.accountId},
                    decision = ${approved ? "approved" : "denied"},
                    code_hash = ${approved ? code.hash : null},
                    code_expires_at = ${approved ? toTimestamptz(EpochMs.parse(txNow + CODE_TTL_MS)) : null}::timestamptz
                where id = ${params.requestId}`,
        );
        if (!updated.ok) return updated;
        const query = new URLSearchParams(
            approved ? { code: code.token, state } : { error: "access_denied", state },
        );
        return ok({ redirectTo: `${redirectUri}?${query.toString()}` });
    });
}

async function revokeFamily(tx: Tx, familyId: Uint8Array, txNow: EpochMs) {
    return await execute(
        tx,
        sql`update native_token_family set revoked_at = ${toTimestamptz(txNow)}::timestamptz
            where id = ${familyId} and revoked_at is null`,
    );
}

// A fresh refresh token (the family's only live one) and an access token, both bound to the
// family's key.
async function mintTokens(
    tx: Tx,
    params: {
        readonly rng: CryptoRng;
        readonly familyId: Uint8Array;
        readonly parentHash: Uint8Array | null;
        readonly txNow: EpochMs;
    },
): Promise<Result<TokenSet, DbFailure>> {
    const refresh = await issueToken(params.rng);
    const access = await issueToken(params.rng);
    const now = params.txNow;
    const insertedRefresh = await execute(
        tx,
        sql`insert into native_refresh_token (token_hash, family_id, parent_hash, issued_at, expires_at)
            values (${refresh.hash}, ${params.familyId}, ${params.parentHash},
                    ${toTimestamptz(now)}::timestamptz,
                    ${toTimestamptz(EpochMs.parse(now + REFRESH_TOKEN_TTL_MS))}::timestamptz)`,
    );
    if (!insertedRefresh.ok) return insertedRefresh;
    const insertedAccess = await execute(
        tx,
        sql`insert into native_access_token (token_hash, family_id, expires_at)
            values (${access.hash}, ${params.familyId},
                    ${toTimestamptz(EpochMs.parse(now + ACCESS_TOKEN_TTL_MS))}::timestamptz)`,
    );
    if (!insertedAccess.ok) return insertedAccess;
    return ok({
        accessToken: access.token,
        refreshToken: refresh.token,
        expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1_000,
    });
}

const CodeRowSchema = z.object({ id: SignInRequestId, account_id: AccountId });

// grant_type=authorization_code. A code presented twice revokes what its first redemption
// issued (RFC 6749 §4.1.2): one of the two presenters isn't the loader that asked.
export async function redeemCode(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly proof: DpopProof;
        readonly form: ReadonlyMap<string, string>;
    },
): Promise<Result<TokenSet, OAuthError | DbFailure>> {
    const { form } = params;
    if (form.get("client_id") !== LOADER_CLIENT_ID) return oauthError("invalid_client");
    const code = BearerToken.safeParse(form.get("code"));
    const verifier = form.get("code_verifier") ?? "";
    if (!code.success || !VERIFIER.test(verifier)) return oauthError("invalid_request");
    const codeHash = await hashToken(code.data);
    const challenge = await sha256Base64Url(verifier);
    const familyId = newWireId(params.rng);

    return await withTx(db, async (tx, txNow) => {
        const found = await queryOne(
            tx,
            CodeRowSchema,
            sql`select id, account_id from native_auth_request where code_hash = ${codeHash}`,
        );
        if (!found.ok) return found;
        if (found.value === null) return oauthError("invalid_grant");
        const account = await lockActiveAccount(tx, found.value.account_id, txNow);
        if (!account.ok) {
            const failure = account.error;
            return failure.code === "ACCOUNT_SUSPENDED"
                ? oauthError("invalid_grant")
                : err(failure);
        }
        const row = await queryOne(
            tx,
            RequestRowSchema,
            sql`select jkt, redirect_uri, code_challenge, state, expires_at, account_id, decision,
                       code_expires_at, redeemed_at, family_id
                from native_auth_request where id = ${found.value.id} for update`,
        );
        if (!row.ok) return row;
        invariant(row.value !== null, "a request found by its code exists under lock");
        const request = row.value;
        if (request.redeemed_at !== null) {
            if (request.family_id !== null) {
                const revoked = await revokeFamily(tx, request.family_id, txNow);
                if (!revoked.ok) return revoked;
            }
            return errCommit<OAuthError>({ code: "invalid_grant" });
        }
        if (
            request.code_expires_at === null ||
            request.code_expires_at <= txNow ||
            request.jkt !== params.proof.jkt ||
            request.redirect_uri !== form.get("redirect_uri") ||
            request.code_challenge !== challenge
        ) {
            return oauthError("invalid_grant");
        }
        const family = await execute(
            tx,
            sql`insert into native_token_family (id, account_id, jkt, created_at)
                values (${familyId}, ${found.value.account_id}, ${request.jkt},
                        ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!family.ok) return family;
        const redeemed = await execute(
            tx,
            sql`update native_auth_request
                set redeemed_at = ${toTimestamptz(txNow)}::timestamptz, family_id = ${familyId}
                where id = ${found.value.id}`,
        );
        if (!redeemed.ok) return redeemed;
        return await mintTokens(tx, { rng: params.rng, familyId, parentHash: null, txNow });
    });
}

const RefreshRowSchema = z.object({
    family_id: z.instanceof(Uint8Array),
    account_id: AccountId,
});

const LockedRefreshSchema = z.object({
    jkt: z.string(),
    revoked_at: EpochMs.nullable(),
    expires_at: EpochMs,
    rotated_at: EpochMs.nullable(),
    live_parent: z.instanceof(Uint8Array).nullable(),
    has_live: z.boolean(),
});

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
    return (
        left !== null &&
        left.byteLength === right.byteLength &&
        left.every((b, i) => b === right[i])
    );
}

// grant_type=refresh_token. The token rotates: its successor is the family's only live token. A
// retry within the grace replaces the successor it got (whose reply was lost); a token presented
// again after the grace, or after its successor was itself used, revokes the whole family.
export async function refreshTokens(
    db: Db,
    params: {
        readonly rng: CryptoRng;
        readonly proof: DpopProof;
        readonly form: ReadonlyMap<string, string>;
    },
): Promise<Result<TokenSet, OAuthError | DbFailure>> {
    const { form } = params;
    if (form.get("client_id") !== LOADER_CLIENT_ID) return oauthError("invalid_client");
    const token = BearerToken.safeParse(form.get("refresh_token"));
    if (!token.success) return oauthError("invalid_request");
    const tokenHash = await hashToken(token.data);

    return await withTx(db, async (tx, txNow) => {
        const found = await queryOne(
            tx,
            RefreshRowSchema,
            sql`select t.family_id, f.account_id
                from native_refresh_token t join native_token_family f on f.id = t.family_id
                where t.token_hash = ${tokenHash}`,
        );
        if (!found.ok) return found;
        if (found.value === null) return oauthError("invalid_grant");
        const { family_id: familyId, account_id: accountId } = found.value;
        const account = await lockActiveAccount(tx, accountId, txNow);
        if (!account.ok) {
            const failure = account.error;
            return failure.code === "ACCOUNT_SUSPENDED"
                ? oauthError("invalid_grant")
                : err(failure);
        }
        // The family row serializes every refresh in it.
        const row = await queryOne(
            tx,
            LockedRefreshSchema,
            sql`select f.jkt, f.revoked_at, t.expires_at, t.rotated_at,
                       live.parent_hash as live_parent, live.token_hash is not null as has_live
                from native_token_family f
                join native_refresh_token t on t.token_hash = ${tokenHash}
                left join native_refresh_token live
                       on live.family_id = f.id and live.rotated_at is null
                where f.id = ${familyId}
                for update of f`,
        );
        if (!row.ok) return row;
        invariant(row.value !== null, "a refresh token's family exists under lock");
        const held = row.value;
        if (held.revoked_at !== null || held.jkt !== params.proof.jkt || held.expires_at <= txNow) {
            return oauthError("invalid_grant");
        }
        const now = toTimestamptz(txNow);
        if (held.rotated_at === null) {
            const rotated = await execute(
                tx,
                sql`update native_refresh_token set rotated_at = ${now}::timestamptz
                    where token_hash = ${tokenHash}`,
            );
            if (!rotated.ok) return rotated;
            return await mintTokens(tx, {
                rng: params.rng,
                familyId,
                parentHash: tokenHash,
                txNow,
            });
        }
        const withinGrace = txNow - held.rotated_at <= REFRESH_RETRY_GRACE_MS;
        if (withinGrace && held.has_live && sameBytes(held.live_parent, tokenHash)) {
            const superseded = await execute(
                tx,
                sql`update native_refresh_token set rotated_at = ${now}::timestamptz
                    where family_id = ${familyId} and rotated_at is null`,
            );
            if (!superseded.ok) return superseded;
            return await mintTokens(tx, {
                rng: params.rng,
                familyId,
                parentHash: tokenHash,
                txNow,
            });
        }
        const revoked = await revokeFamily(tx, familyId, txNow);
        if (!revoked.ok) return revoked;
        return errCommit<OAuthError>({ code: "invalid_grant" });
    });
}

export type TokenHolder = {
    readonly accountId: AccountId;
    readonly familyId: Uint8Array;
};

export type AuthRequired = { readonly code: "AUTH_REQUIRED" };

const AccessRowSchema = z.object({
    account_id: AccountId,
    family_id: z.instanceof(Uint8Array),
    jkt: z.string(),
});

// The access token's holder, when it is live, its family isn't revoked, and the request is
// proven by the key it was issued to.
export async function resolveAccessToken(
    q: Queryable,
    params: { readonly token: BearerToken; readonly proof: DpopProof },
): Promise<Result<TokenHolder, AuthRequired | DbFailure>> {
    const tokenHash = await hashToken(params.token);
    const row = await queryOne(
        q,
        AccessRowSchema,
        sql`select f.account_id, f.id as family_id, f.jkt
            from native_access_token t join native_token_family f on f.id = t.family_id
            where t.token_hash = ${tokenHash} and t.expires_at > now() and f.revoked_at is null`,
    );
    if (!row.ok) return row;
    if (row.value === null || row.value.jkt !== params.proof.jkt) {
        return err({ code: "AUTH_REQUIRED" });
    }
    return ok({ accountId: row.value.account_id, familyId: row.value.family_id });
}
