import { tryAsync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { OperationId } from "@lucent/core/scalars";
import { type RefusalCode, toRefusalBytes } from "@lucent/wire/refusal";

// What every /v1 route shares: binary bodies in and out, the refusal body for every refusal, and
// the operation id that makes a retried write return its first answer.

// Big enough for every /v1 message the loader sends (the largest, a lease request, is a few
// hundred bytes); anything bigger is refused before it is buffered.
export const MAX_NATIVE_BODY_BYTES = 16 * 1024;

// The data route's requests may carry a feature list, which can reach 32 KiB.
export const MAX_DATA_BODY_BYTES = 64 * 1024;

export const OPERATION_HEADER = "lucent-operation";

export type NativeRefusal = {
    readonly code: RefusalCode;
    readonly retryAfterMs?: number;
};

// The status says what kind of failure it is to anything between loader and server; the body
// says which. 503 only for the server's own failures.
const STATUS: Readonly<Record<RefusalCode, number>> = {
    AUTH_REQUIRED: 401,
    PROOF_INVALID: 401,
    ENTITLEMENT_INACTIVE: 403,
    DEVICE_REVOKED: 403,
    RELEASE_UNAVAILABLE: 409,
    CHANNEL_NOT_ALLOWED: 403,
    ACCOUNT_SUSPENDED: 403,
    NOT_FOUND: 404,
    SLOT_TAKEN: 409,
    STALE_SEQUENCE: 409,
    IDEMPOTENCY_CONFLICT: 409,
    ALREADY_ENROLLED: 409,
    KEY_IN_USE: 409,
    ENROLLMENT_LIMIT: 409,
    START_MISMATCH: 409,
    SESSION_ENDED: 410,
    START_EXPIRED: 410,
    INVALID_REQUEST: 400,
    GAME_BUILD_UNSUPPORTED: 409,
    GAME_UPDATE_REQUIRED: 409,
    LOADER_UPDATE_REQUIRED: 409,
    RATE_LIMITED: 429,
    SERVICE_UNAVAILABLE: 503,
};

const BINARY = "application/octet-stream";

export function refusalResponse(refusal: NativeRefusal): Response {
    const retryAfterMs = refusal.retryAfterMs ?? null;
    const headers: Record<string, string> = { "content-type": BINARY, "cache-control": "no-store" };
    if (retryAfterMs !== null) {
        headers["retry-after"] = String(Math.ceil(retryAfterMs / 1_000));
    }
    if (refusal.code === "PROOF_INVALID") {
        headers["www-authenticate"] = 'DPoP error="invalid_dpop_proof"';
    }
    if (refusal.code === "AUTH_REQUIRED") {
        headers["www-authenticate"] = 'DPoP algs="ES256"';
    }
    return new Response(toRefusalBytes({ code: refusal.code, retryAfterMs }), {
        status: STATUS[refusal.code],
        headers,
    });
}

export function binaryResponse(body: Uint8Array<ArrayBuffer>, status = 200): Response {
    return new Response(body, {
        status,
        headers: { "content-type": BINARY, "cache-control": "no-store" },
    });
}

export function refuse(code: RefusalCode): Result<never, NativeRefusal> {
    return err({ code });
}

export type BodyRefusal = { readonly code: "PAYLOAD_TOO_LARGE" | "INVALID_REQUEST" };

// The body, streamed in under a cap: a declared or actual length over it is refused before the
// rest is read.
export async function readBoundedBody(
    req: Request,
    maxBytes = MAX_NATIVE_BODY_BYTES,
): Promise<Result<Uint8Array<ArrayBuffer>, BodyRefusal>> {
    const declared = req.headers.get("content-length");
    if (declared !== null) {
        const length = Number(declared);
        if (!Number.isFinite(length) || length > maxBytes)
            return err({ code: "PAYLOAD_TOO_LARGE" });
    }
    if (req.body === null) return ok(new Uint8Array(0));
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const read = await tryAsync(
        async () => {
            for (;;) {
                const step = await reader.read();
                if (step.done) return "complete" as const;
                total += step.value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel();
                    return "too_large" as const;
                }
                chunks.push(step.value);
            }
        },
        () => ({ code: "INVALID_REQUEST" as const }),
    );
    if (!read.ok) return read;
    if (read.value === "too_large") return err({ code: "PAYLOAD_TOO_LARGE" });
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return ok(merged);
}

// Writes that create something carry one; a retry with the same id and body gets the first
// answer, and the same id with another body is IDEMPOTENCY_CONFLICT.
export function operationIdOf(req: Request): OperationId | null {
    const parsed = OperationId.safeParse(req.headers.get(OPERATION_HEADER));
    return parsed.success ? parsed.data : null;
}

// Wire ids are 16 bytes; in a path, 32 lowercase hex digits.
export function parseIdSegment(segment: string): Uint8Array | null {
    if (!/^[0-9a-f]{32}$/.test(segment)) return null;
    return Uint8Array.fromHex(segment);
}
