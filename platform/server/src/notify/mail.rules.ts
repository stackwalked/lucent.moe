import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";

// https://resend.com/docs/dashboard/emails/idempotency-keys: 24 hours, same request.
// https://developers.brevo.com/changelog/2021/11/10: 15 minutes for transactional email.
// The newer batch guide says 30 minutes; do not extend single-message retries on that basis.
const WINDOW_MS = { resend: 86_400_000, brevo: 900_000, log: 86_400_000 } as const;
const LEASE_MS = 30_000;
// Reserve a minute for the 10s request, scheduling and clock differences between workers.
const SAFETY_MS = 60_000;
const MAX_ATTEMPTS = 12;

export function decideMailClaim(params: {
    readonly provider: keyof typeof WINDOW_MS;
    readonly now: EpochMs;
    readonly first: EpochMs | null;
    readonly attempts: number;
    readonly sameBinding: boolean;
}) {
    const first = params.first ?? params.now;
    const stopAt = EpochMs.parse(first + WINDOW_MS[params.provider] - SAFETY_MS);
    if (
        !params.sameBinding ||
        params.now < first ||
        params.now >= stopAt ||
        params.attempts >= MAX_ATTEMPTS
    )
        return err({ code: "unconfirmed" });
    return ok({
        first,
        stopAt,
        attempt: params.attempts + 1,
        leaseUntil: EpochMs.parse(params.now + LEASE_MS),
    });
}

export function decideMailRetry(params: {
    readonly now: EpochMs;
    readonly attempt: number;
    readonly first: EpochMs;
    readonly stopAt: EpochMs;
}) {
    const retryAt = EpochMs.parse(
        params.now + Math.min(120_000, 5_000 * 2 ** (params.attempt - 1)),
    );
    if (params.attempt >= MAX_ATTEMPTS || params.now < params.first || retryAt >= params.stopAt)
        return err({ code: "unconfirmed" });
    return ok(retryAt);
}
