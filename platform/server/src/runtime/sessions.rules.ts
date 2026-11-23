import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, toHex } from "@lucent/core/scalars";
import { LEASE_DURATION_MS, RESUME_WINDOW_MS, SESSION_CAP_MS } from "./leases.ts";

type Code<C extends string> = { readonly code: C };

// Why a session ended, as runtime_session.end_reason stores it.
export type EndReason =
    | "closed"
    | "slot_taken"
    | "suspended"
    | "device_revoked"
    | "expired"
    | "capped";

// What an ended session answers from then on: the reason it ended, where the loader shows one.
export type SessionEnded = Code<
    "SESSION_ENDED" | "SLOT_TAKEN" | "ACCOUNT_SUSPENDED" | "DEVICE_REVOKED"
>;

function refusalOf(reason: EndReason): SessionEnded {
    switch (reason) {
        case "slot_taken":
            return { code: "SLOT_TAKEN" };
        case "suspended":
            return { code: "ACCOUNT_SUSPENDED" };
        case "device_revoked":
            return { code: "DEVICE_REVOKED" };
        case "closed":
        case "expired":
        case "capped":
            return { code: "SESSION_ENDED" };
    }
}

export function decideLiveSession(reason: EndReason | null): Result<void, SessionEnded> {
    return reason === null ? ok(undefined) : err(refusalOf(reason));
}

// Refuse suspension before the PC, the slot before either deadline. Renewals and data agree.
export function decideSessionStanding(params: {
    readonly session: {
        readonly slot_generation: bigint;
        readonly lease_expires_at: EpochMs;
        readonly created_at: EpochMs;
    };
    readonly slot: { readonly generation: bigint };
    readonly accountActive: boolean;
    readonly deviceRevoked: boolean;
    readonly txNow: EpochMs;
}): Result<void, { readonly reason: EndReason; readonly refusal: SessionEnded }> {
    const { session, txNow } = params;
    function end(reason: EndReason) {
        return err({ reason, refusal: refusalOf(reason) });
    }
    if (!params.accountActive) return end("suspended");
    if (params.deviceRevoked) return end("device_revoked");
    if (params.slot.generation !== session.slot_generation) return end("slot_taken");
    if (session.lease_expires_at + RESUME_WINDOW_MS <= txNow) return end("expired");
    if (session.created_at + SESSION_CAP_MS <= txNow) return end("capped");
    return ok(undefined);
}

export function decideOpenDevice(
    device: { readonly revokedAt: EpochMs | null; readonly jkt: string },
    jkt: string,
): Result<void, Code<"DEVICE_REVOKED" | "START_MISMATCH">> {
    if (device.revokedAt !== null) return err({ code: "DEVICE_REVOKED" });
    return device.jkt === jkt ? ok(undefined) : err({ code: "START_MISMATCH" });
}

export function decideSessionAccess(
    access: { readonly isEntitled: boolean; readonly channels: readonly string[] },
    channel: string,
): Result<void, Code<"ENTITLEMENT_INACTIVE" | "CHANNEL_NOT_ALLOWED">> {
    if (!access.isEntitled) return err({ code: "ENTITLEMENT_INACTIVE" });
    return access.channels.includes(channel) ? ok(undefined) : err({ code: "CHANNEL_NOT_ALLOWED" });
}

export function decideOpenSession(params: {
    readonly unused: boolean;
    readonly expiresAt: EpochMs;
    readonly txNow: EpochMs;
    readonly helloRelease: Uint8Array;
    readonly startRelease: Uint8Array;
    readonly generation: bigint;
}): Result<
    { readonly generation: bigint; readonly deadline: EpochMs },
    Code<"START_EXPIRED" | "START_MISMATCH">
> {
    if (!params.unused || params.expiresAt <= params.txNow) return err({ code: "START_EXPIRED" });
    if (toHex(params.helloRelease) !== toHex(params.startRelease))
        return err({ code: "START_MISMATCH" });
    return ok({
        generation: params.generation + 1n,
        deadline: EpochMs.parse(params.txNow + LEASE_DURATION_MS),
    });
}

export function decideReplaySequence(
    current: bigint,
    replayed: bigint,
): Result<void, Code<"STALE_SEQUENCE">> {
    return current === replayed ? ok(undefined) : err({ code: "STALE_SEQUENCE" });
}

export function decideRenewalFrame(
    received: bigint,
    last: bigint,
): Result<void, Code<"STALE_SEQUENCE">> {
    return received <= last ? err({ code: "STALE_SEQUENCE" }) : ok(undefined);
}

export function decideRenewLease(
    current: bigint,
    received: bigint,
    txNow: EpochMs,
): Result<{ readonly sequence: bigint; readonly deadline: EpochMs }, Code<"STALE_SEQUENCE">> {
    const sequence = current + 1n;
    return received === sequence
        ? ok({ sequence, deadline: EpochMs.parse(txNow + LEASE_DURATION_MS) })
        : err({ code: "STALE_SEQUENCE" });
}

export function decideCloseSession(
    reason: EndReason | null,
): Result<"close" | "already_ended", never> {
    return ok(reason === null ? "close" : "already_ended");
}
