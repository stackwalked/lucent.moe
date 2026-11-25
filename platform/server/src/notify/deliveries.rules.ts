import { ok, type Result } from "@lucent/core/result";
import type { ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import type { Channels } from "@lucent/rpc/web/preferences";

export const SECURITY_CHANNELS = { inbox: true, mail: true, discord: false } as const;
export const PRODUCT_DEFAULTS = { inbox: true, mail: false, discord: false } as const;
export const TICKET_REPLY_DEFAULTS = { inbox: true, mail: true, discord: false } as const;

// What the member chose: product status and ticket reply channels (null: never chosen), and
// whether security notices also go to Discord.
export type StoredPreferences = {
    readonly productStatus: Channels | null;
    readonly ticketReply: Channels | null;
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
    if (notice.kind === "ticket_reply") {
        // Never a DM here: connector_discord_dm.kind does not list this kind, and the Discord
        // connector's stage C, built apart from this change, owns adding it. Until then the
        // member's choice has no Discord channel to hold.
        const chosen = preferences.ticketReply ?? TICKET_REPLY_DEFAULTS;
        return ok({ inbox: chosen.inbox, mail: chosen.mail, discord: false });
    }
    if (!subscriptions.includes(notice.productId)) {
        return ok({ inbox: false, mail: false, discord: false });
    }
    return ok(preferences.productStatus ?? PRODUCT_DEFAULTS);
}
