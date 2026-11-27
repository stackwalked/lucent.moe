import { type API, ButtonStyle, ComponentType } from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { describeUnknownError, tryAsync } from "@lucent/core/contain";
import type { RpcClient } from "@lucent/rpc/client";
import type { DiscordContract } from "@lucent/rpc/discord/contract";
import { DM_COPY } from "./copy.ts";

// Discord's codes for a DM the member's own settings stop: "cannot send messages to this user"
// (DMs closed, the bot blocked, no shared server) and "unknown user". Trying again changes
// nothing, so they are settled as refused. https://discord.com/developers/docs/topics/opcodes-and-status-codes
const REFUSED_CODES: ReadonlySet<number | string> = new Set([50007, 10013]);

type DueNotice =
    | { readonly kind: "security" }
    | { readonly kind: "product_status"; readonly product: string }
    | {
          readonly kind: "subscription_ending";
          readonly product: string | null;
          readonly endsAt: number;
      };

function dmContent(notice: DueNotice): string {
    switch (notice.kind) {
        case "security":
            return DM_COPY.security;
        case "product_status":
            return DM_COPY.productStatus(notice.product);
        case "subscription_ending":
            return DM_COPY.subscriptionEnding(notice.product, notice.endsAt);
    }
}

// Each due notice goes out as a DM saying that something happened, with a link to the inbox, and
// is settled with how it went; platform decides whether a failure is tried again.
export async function sendDueDms(deps: {
    readonly api: API;
    readonly platform: RpcClient<DiscordContract>;
    readonly warn: (msg: string, detail: string) => void;
}): Promise<void> {
    const due = await deps.platform.call("dms.read", {});
    if (!due.ok) {
        deps.warn("dms unavailable", due.error.code);
        return;
    }
    for (const dm of due.value.dms) {
        const sent = await tryAsync(
            async () => {
                const channel = await deps.api.users.createDM(dm.userId);
                return await deps.api.channels.createMessage(channel.id, {
                    content: dmContent(dm.notice),
                    allowed_mentions: { parse: [] },
                    components: [
                        {
                            type: ComponentType.ActionRow,
                            components: [
                                {
                                    type: ComponentType.Button,
                                    style: ButtonStyle.Link,
                                    label: DM_COPY.open,
                                    url: dm.url,
                                },
                            ],
                        },
                    ],
                });
            },
            (cause) => cause,
        );
        const refused =
            !sent.ok && sent.error instanceof DiscordAPIError && REFUSED_CODES.has(sent.error.code);
        if (!sent.ok && !refused) deps.warn("dm failed", describeUnknownError(sent.error));
        const settled = await deps.platform.call("dms.settled", {
            id: dm.id,
            outcome: sent.ok ? "sent" : refused ? "refused" : "failed",
        });
        // Sent but not settled: the next tick sends it again. At least once.
        if (!settled.ok) deps.warn("dm not settled", settled.error.code);
    }
}
