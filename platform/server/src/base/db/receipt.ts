import { err, ok, type Result } from "@lucent/core/result";
import { type OperationId, sha256Base64Url } from "@lucent/core/scalars";
import { z } from "zod";
import { type DbFailure, execute, queryOne, sql, type Tx } from "./pool.ts";

export type OperationKey = {
    readonly principal: string;
    readonly endpoint: string;
    readonly operationId: OperationId;
    readonly digest: string;
};

export type ReceiptRefusal =
    | { readonly code: "IDEMPOTENCY_CONFLICT" }
    | { readonly code: "RECEIPT_UNREADABLE" };

export type Replay<T> =
    | { readonly replayed: false }
    | { readonly replayed: true; readonly result: T };

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    if (typeof value === "object" && value !== null) {
        const entries: [string, unknown][] = Object.entries(value);
        const present = entries
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${present.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export async function toOperationKey(params: {
    readonly principal: string;
    readonly endpoint: string;
    readonly operationId: OperationId;
    readonly payload: Record<string, unknown>;
}): Promise<OperationKey> {
    const digest = await sha256Base64Url(canonicalJson(params.payload));
    return {
        principal: params.principal,
        endpoint: params.endpoint,
        operationId: params.operationId,
        digest,
    };
}

const ReceiptRowSchema = z.object({
    digest: z.string(),
    result: z.unknown(),
});

// Race-free only while the caller holds a lock that serializes every writer for `op.principal`;
// otherwise two first attempts both read "not replayed" and the second insert hits the key.
export async function readReplay<ResultSchema extends z.ZodType>(
    tx: Tx,
    op: OperationKey,
    resultSchema: ResultSchema,
): Promise<Result<Replay<z.output<ResultSchema>>, ReceiptRefusal | DbFailure>> {
    const rowRes = await queryOne(
        tx,
        ReceiptRowSchema,
        sql`select digest, result from receipt
            where principal = ${op.principal}
              and endpoint = ${op.endpoint}
              and operation_id = ${op.operationId}`,
    );
    if (!rowRes.ok) return rowRes;
    if (rowRes.value === null) return ok({ replayed: false });
    if (rowRes.value.digest !== op.digest) {
        return err({ code: "IDEMPOTENCY_CONFLICT" });
    }
    const parsed = resultSchema.safeParse(rowRes.value.result);
    if (!parsed.success) {
        return err({ code: "RECEIPT_UNREADABLE" });
    }
    return ok({ replayed: true, result: parsed.data });
}

export async function recordReceipt(
    tx: Tx,
    op: OperationKey,
    result: unknown,
): Promise<Result<void, DbFailure>> {
    const inserted = await execute(
        tx,
        sql`insert into receipt (principal, endpoint, operation_id, digest, result)
            values (${op.principal}, ${op.endpoint}, ${op.operationId}, ${op.digest}, ${JSON.stringify(result)}::jsonb)`,
    );
    if (!inserted.ok) return inserted;
    return ok(undefined);
}
