import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import type { CryptoRng } from "../core/rng.ts";
import { AccountId, type BearerToken, EpochMs } from "../core/scalars.ts";
import {
    type DbFailure,
    execute,
    type Queryable,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { hashToken, issueToken } from "./tokens.ts";

// A sign-in, step-up or registration in progress, held by the browser in `__Host-lucent-flow`.
const FLOW_TTL_MS = 10 * 60 * 1_000;
// Wrong codes or assertions before the flow dies and the sign-in starts over from the password.
export const MAX_FLOW_FAILURES = 5;

export type FlowKind = "sign_in" | "step_up" | "register";

export type Flow = {
    readonly tokenHash: Uint8Array;
    readonly kind: FlowKind;
    readonly accountId: AccountId | null;
    readonly sessionHash: Uint8Array | null;
    readonly passwordOk: boolean;
    readonly challenge: Uint8Array | null;
    readonly failures: number;
};

export type FlowRefusal = { readonly code: "FLOW_INVALID" };

const Bytes = z.instanceof(Uint8Array);

const FlowRowSchema = z.object({
    kind: z.enum(["sign_in", "step_up", "register"]),
    account_id: AccountId.nullable(),
    session_hash: Bytes.nullable(),
    password_ok: z.boolean(),
    challenge: Bytes.nullable(),
    failures: z.number().int(),
});

export async function startFlow(
    tx: Tx,
    params: {
        readonly rng: CryptoRng;
        readonly kind: FlowKind;
        readonly accountId: AccountId | null;
        readonly sessionHash: Uint8Array | null;
        readonly passwordOk: "password verified" | "no password";
        readonly challenge: Uint8Array | null;
        readonly txNow: EpochMs;
    },
): Promise<Result<BearerToken, DbFailure>> {
    const issued = await issueToken(params.rng);
    const expiresAt = EpochMs.parse(params.txNow + FLOW_TTL_MS);
    const inserted = await execute(
        tx,
        sql`insert into auth_flow
                (token_hash, kind, account_id, session_hash, password_ok, challenge, expires_at)
            values (${issued.hash}, ${params.kind}, ${params.accountId}, ${params.sessionHash},
                    ${params.passwordOk === "password verified"}, ${params.challenge},
                    ${toTimestamptz(expiresAt)}::timestamptz)`,
    );
    if (!inserted.ok) return inserted;
    return ok(issued.token);
}

// Unlocked: it names the account to lock first. Writers then re-read it with `lockFlow`.
export async function readFlow(
    q: Queryable,
    params: { readonly token: BearerToken; readonly kind: FlowKind; readonly txNow: EpochMs },
): Promise<Result<Flow, FlowRefusal | DbFailure>> {
    return await findFlow(q, { ...params, tokenHash: await hashToken(params.token), lock: sql`` });
}

export function lockFlow(
    tx: Tx,
    params: { readonly tokenHash: Uint8Array; readonly kind: FlowKind; readonly txNow: EpochMs },
): Promise<Result<Flow, FlowRefusal | DbFailure>> {
    return findFlow(tx, { ...params, lock: sql`for update` });
}

async function findFlow(
    q: Queryable,
    params: {
        readonly tokenHash: Uint8Array;
        readonly kind: FlowKind;
        readonly txNow: EpochMs;
        readonly lock: SqlFragment;
    },
): Promise<Result<Flow, FlowRefusal | DbFailure>> {
    const row = await queryOne(
        q,
        FlowRowSchema,
        sql`select kind, account_id, session_hash, password_ok, challenge, failures
            from auth_flow
            where token_hash = ${params.tokenHash} and kind = ${params.kind}
              and expires_at > ${toTimestamptz(params.txNow)}::timestamptz
            ${params.lock}`,
    );
    if (!row.ok) return row;
    if (row.value === null) return err({ code: "FLOW_INVALID" });
    return ok({
        tokenHash: params.tokenHash,
        kind: row.value.kind,
        accountId: row.value.account_id,
        sessionHash: row.value.session_hash,
        passwordOk: row.value.password_ok,
        challenge: row.value.challenge,
        failures: row.value.failures,
    });
}

export async function setFlowChallenge(
    tx: Tx,
    tokenHash: Uint8Array,
    challenge: Uint8Array | null,
): Promise<Result<void, DbFailure>> {
    const res = await execute(
        tx,
        sql`update auth_flow set challenge = ${challenge} where token_hash = ${tokenHash}`,
    );
    if (!res.ok) return res;
    return ok(undefined);
}

export async function endFlow(tx: Tx, tokenHash: Uint8Array): Promise<Result<void, DbFailure>> {
    const res = await execute(tx, sql`delete from auth_flow where token_hash = ${tokenHash}`);
    if (!res.ok) return res;
    return ok(undefined);
}

// Counts a wrong answer; the last allowed one ends the flow.
export async function failFlow(tx: Tx, flow: Flow): Promise<Result<void, DbFailure>> {
    if (flow.failures + 1 >= MAX_FLOW_FAILURES) return await endFlow(tx, flow.tokenHash);
    const res = await execute(
        tx,
        sql`update auth_flow set failures = failures + 1, challenge = null
            where token_hash = ${flow.tokenHash}`,
    );
    if (!res.ok) return res;
    return ok(undefined);
}
