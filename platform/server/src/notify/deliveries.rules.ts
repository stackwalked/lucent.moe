import { ok, type Result } from "@lucent/core/result";
import type { ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import type { Channels } from "@lucent/rpc/web/preferences";

export const SECURITY_CHANNELS = { inbox: true, mail: true, discord: false } as const;
export const PRODUCT_DEFAULTS = { inbox: true, mail: false, discord: false } as const;

// What the member chose: product status channels (null: never chosen), and whether security
// notices also go to Discord.
export type StoredPreferences = {
    readonly productStatus: Channels | null;
    readonly securityDiscord: boolean;
};

export function decideDeliveries(
    notice: Notice,
    preferences: StoredPreferences,
    subscriptions: readonly ProductId[],
): Result<Channels, never> {
    if (notice.kind === "security") {
        return ok({ ...SECURITY_CHANNELS, discord: preferences.securityDiscord });
    }
    if (!subscriptions.includes(notice.productId)) {
        return ok({ inbox: false, mail: false, discord: false });
    }
    return ok(preferences.productStatus ?? PRODUCT_DEFAULTS);
}
