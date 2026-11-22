import { err, ok, type Result } from "@lucent/core/result";
import { type AccountId, EpochMs, toHex } from "@lucent/core/scalars";

type Capacity = { readonly liveCount: number; readonly limit: number };
type Code<C extends string> = { readonly code: C };
type EnrollmentPlan = "check_window" | "enroll";

export function decideEnrollmentRequest(
    params: Capacity & {
        readonly owner: AccountId | null;
        readonly accountId: AccountId;
    },
): Result<EnrollmentPlan, Code<"ALREADY_ENROLLED" | "KEY_IN_USE">> {
    if (params.owner === params.accountId) return err({ code: "ALREADY_ENROLLED" });
    if (params.owner !== null) return err({ code: "KEY_IN_USE" });
    return ok(params.liveCount >= params.limit ? "check_window" : "enroll");
}

export function decideEnrollmentApproval(
    params: Capacity & {
        readonly owner: AccountId | null;
    },
): Result<EnrollmentPlan, Code<"FORBIDDEN">> {
    if (params.owner !== null) return err({ code: "FORBIDDEN" });
    return ok(params.liveCount >= params.limit ? "check_window" : "enroll");
}

export function decideDeviceChange<C extends string>(params: {
    readonly lastReplacedAt: EpochMs | null;
    readonly txNow: EpochMs;
    readonly windowMs: number;
    readonly refusal: Code<C>;
}): Result<void, Code<C>> {
    if (params.lastReplacedAt !== null && params.lastReplacedAt + params.windowMs > params.txNow) {
        return err(params.refusal);
    }
    return ok(undefined);
}

export function decidePendingRequest<
    Row extends { readonly expires_at: EpochMs; readonly id: Uint8Array },
>(
    row: Row | null,
    txNow: EpochMs,
    ttlMs: number,
): Result<
    | { readonly kind: "reuse"; readonly row: Row }
    | { readonly kind: "insert"; readonly expire: Uint8Array | null; readonly expiresAt: EpochMs },
    never
> {
    if (row !== null && row.expires_at > txNow) return ok({ kind: "reuse", row });
    return ok({ kind: "insert", expire: row?.id ?? null, expiresAt: EpochMs.parse(txNow + ttlMs) });
}

export function decidePendingEnrollment<
    Row extends { readonly state: string; readonly expires_at: EpochMs },
>(row: Row | null, txNow: EpochMs): Result<Row, Code<"NOT_FOUND">> {
    if (row === null || row.state !== "pending" || row.expires_at <= txNow)
        return err({ code: "NOT_FOUND" });
    return ok(row);
}

export function decideDeviceRemoval(
    live: readonly Uint8Array[],
    deviceId: Uint8Array,
): Result<void, Code<"NOT_FOUND">> {
    return live.some((id) => toHex(id) === toHex(deviceId))
        ? ok(undefined)
        : err({ code: "NOT_FOUND" });
}
