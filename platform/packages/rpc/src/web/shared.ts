import { AccountId, EpochMs, FeatureTag } from "@lucent/core/scalars";
import { z } from "zod";

// What web may ask platform, and what each answer can be. Inputs are strict; outputs and refusals
// are `z.object`, which drops fields it doesn't know, so platform can add one a deploy before web
// reads it. A procedure's `session` names who may call it; the token travels in `Lucent-Session`.

export function refusal<const Code extends string>(code: Code) {
    return z.object({ code: z.literal(code) });
}

export const Unavailable = refusal("SERVICE_UNAVAILABLE");

export const SessionRefusals = [
    refusal("SESSION_INVALID"),
    z.object({ code: z.literal("REAUTH_REQUIRED"), withinSeconds: z.number() }),
] as const;

export const SessionRefusal = z.discriminatedUnion("code", [Unavailable, ...SessionRefusals]);

export const Done = z.object({});

// Admin procedures run as a member session's account; `can()` decides, under the step-up rule.
export const StaffRefusals = [
    Unavailable,
    refusal("SESSION_INVALID"),
    refusal("FORBIDDEN"),
    z.object({ code: z.literal("STEP_UP_REQUIRED"), withinSeconds: z.number() }),
] as const;

export const ReadRefusal = z.discriminatedUnion("code", [
    ...StaffRefusals,
    refusal("NOT_FOUND"),
    refusal("INVALID_CURSOR"),
]);

// A receipt-backed write reused with different input: the form's operationId went stale.
export const Reused = refusal("IDEMPOTENCY_CONFLICT");

export const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);

export function pageOf<Item extends z.ZodType>(item: Item) {
    return z.object({ items: z.array(item).readonly(), nextCursor: z.string().nullable() });
}

// `operation` and `detail` stay open: rows outlive the code that wrote them.
export const AuditEntry = z.object({
    id: z.string(),
    at: EpochMs,
    actor: z.object({ id: z.string(), username: z.string().nullable() }),
    operation: z.string(),
    target: z.object({
        accountId: AccountId.nullable(),
        username: z.string().nullable(),
        detail: z.record(z.string(), z.unknown()),
    }),
});

export const Username = z.string().max(64);

// The native path's ids as web carries them: 16 bytes in lowercase hex, and the loader's pushed
// sign-in request as it appears in `/auth/device/<id>`.
export const WireId = z.string().regex(/^[0-9a-f]{32}$/);

// The first 40 bits of the device key's thumbprint, `XXXX-XXXX` in Crockford base32.
export const MatchCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

export const KeyStorage = z.enum(["tpm", "software"]);

// A live device as its owner and staff see it. `lastSeenAt` is the last lease a module running on
// it was given; null before its first start.
export const Device = z.object({
    deviceId: WireId,
    name: z.string().nullable(),
    matchCode: MatchCode,
    storage: KeyStorage,
    enrolledAt: EpochMs,
    lastSeenAt: EpochMs.nullable(),
});

// When the member may next replace or remove a device themselves; null when they may now.
export const DeviceWindow = EpochMs.nullable();

export const Features = z.union([z.literal("*"), z.array(FeatureTag).readonly()]);

// Seal numbers are u64 on the wire and bigint in the database: decimal strings, past JSON's safe
// integers.
export const SealNumber = z.string().regex(/^[1-9][0-9]{0,18}$/);
