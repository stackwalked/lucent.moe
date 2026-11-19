import { createWriter, type FormatError, malformed, openReader } from "@lucent/bundle/wire";
import { invariant } from "@lucent/core/contain";
import type { Result } from "@lucent/core/result";
import { finish, readContext, readFlag, writeContext } from "./codec.ts";

// Why the server refused a /v1 request, as native/libs/wire/src/refusal.cpp reads and writes it:
// the body of every 4xx and of a 503. Integrity is never a reason.
//
// Version 1 on the wire: context "lucent refusal v1" (32), u8 code, u8 has retry-after (0 or 1),
// and u32 retry-after in milliseconds after 1 only.
//
// From old lucent's codes: licenses became entitlements (ENTITLEMENT_INACTIVE); releases are
// promoted, not toggled (RELEASE_UNAVAILABLE); the newest session takes a full slot and the old
// one learns it on its next renewal (SLOT_TAKEN); intents became starts (START_MISMATCH,
// START_EXPIRED); the client that must update is the loader (LOADER_UPDATE_REQUIRED).
// INTEGRITY_REFUSED is gone.

const REFUSAL_VERSION = 1;

// In wire order from 1, and stable: a number and name never change or get reused, and none names a
// capability, so the release host can show them from a user-facing catalog. A code this list
// doesn't have still decodes, so adding one needs no new refusal version.
export const REFUSAL_CODES = [
    "AUTH_REQUIRED",
    "PROOF_INVALID",
    "ENTITLEMENT_INACTIVE",
    "DEVICE_REVOKED",
    "RELEASE_UNAVAILABLE",
    "CHANNEL_NOT_ALLOWED",
    "ACCOUNT_SUSPENDED",
    "NOT_FOUND",
    "SLOT_TAKEN",
    "STALE_SEQUENCE",
    "IDEMPOTENCY_CONFLICT",
    "ALREADY_ENROLLED",
    "KEY_IN_USE",
    "ENROLLMENT_LIMIT",
    "START_MISMATCH",
    "SESSION_ENDED",
    "START_EXPIRED",
    "INVALID_REQUEST",
    "GAME_BUILD_UNSUPPORTED",
    "GAME_UPDATE_REQUIRED",
    "LOADER_UPDATE_REQUIRED",
    "RATE_LIMITED",
    "SERVICE_UNAVAILABLE",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

// A code a later build added: it decodes, keeping its number, and the loader shows a generic
// refusal for it.
export type UnknownRefusalCode = { readonly unknown: number };

export type Refusal = {
    readonly code: RefusalCode | UnknownRefusalCode;
    readonly retryAfterMs: number | null;
};

function codeNumber(code: RefusalCode | UnknownRefusalCode): number {
    if (typeof code === "string") {
        return REFUSAL_CODES.indexOf(code) + 1;
    }
    invariant(Number.isInteger(code.unknown), "unknown code");
    invariant(code.unknown > REFUSAL_CODES.length && code.unknown <= 0xff, "unknown code range");
    return code.unknown;
}

export function toRefusalBytes(refusal: Refusal): Uint8Array<ArrayBuffer> {
    const out = createWriter();
    writeContext(out, "refusal", REFUSAL_VERSION);
    out.u8(codeNumber(refusal.code));
    if (refusal.retryAfterMs === null) {
        out.u8(0);
        return out.finish();
    }
    invariant(Number.isInteger(refusal.retryAfterMs) && refusal.retryAfterMs >= 0, "retry-after");
    out.u8(1);
    out.u32(refusal.retryAfterMs);
    return out.finish();
}

// Canonical or nothing: a code other than 0 (an unknown one keeps its number), a retry-after flag
// of 0 or 1 with the value only after 1.
export function parseRefusal(bytes: Uint8Array): Result<Refusal, FormatError> {
    const input = openReader(bytes);
    const context = readContext(input, "refusal", REFUSAL_VERSION);
    if (!context.ok) {
        return context;
    }
    if (input.remaining() < 2) {
        return malformed();
    }
    const number = input.u8();
    const hasRetryAfter = readFlag(input);
    if (number === 0 || hasRetryAfter === null) {
        return malformed();
    }
    const code = REFUSAL_CODES[number - 1] ?? { unknown: number };
    if (!hasRetryAfter) {
        return finish(input, { code, retryAfterMs: null });
    }
    if (input.remaining() < 4) {
        return malformed();
    }
    return finish(input, { code, retryAfterMs: input.u32() });
}
