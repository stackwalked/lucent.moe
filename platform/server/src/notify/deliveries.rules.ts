import { ok, type Result } from "@lucent/core/result";
import type { ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import type { Channels } from "@lucent/rpc/web/preferences";

export const SECURITY_CHANNELS = { inbox: true, mail: true } as const;
export const PRODUCT_DEFAULTS = { inbox: true, mail: false } as const;

export function decideDeliveries(
    notice: Notice,
    preferences: Channels | null,
    subscriptions: readonly ProductId[],
): Result<Channels, never> {
    if (notice.kind === "security") return ok(SECURITY_CHANNELS);
    if (!subscriptions.includes(notice.productId)) return ok({ inbox: false, mail: false });
    return ok(preferences ?? PRODUCT_DEFAULTS);
}
