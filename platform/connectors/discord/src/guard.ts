import type { API, GatewayMessageCreateDispatchData } from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { describeUnknownError, tryAsync } from "@lucent/core/contain";
import type { Logger } from "./log.ts";

// Invites to other Discord servers are taken down wherever members talk; staff channels are left
// alone. One pattern and nothing else: moderation beyond it is people and Discord's own AutoMod.
// lucent.moe's own invite codes join this when admission lands (packet 06).
const DISCORD_INVITE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/[\w-]+/i;

export function isInviteLeak(content: string): boolean {
    return DISCORD_INVITE.test(content);
}

export async function guardMessage(
    deps: {
        readonly api: API;
        readonly guildId: string;
        readonly staffChannels: () => ReadonlySet<string>;
        readonly logger: Logger;
    },
    message: GatewayMessageCreateDispatchData,
): Promise<void> {
    if (message.guild_id !== deps.guildId || message.author.bot === true) return;
    if (deps.staffChannels().has(message.channel_id) || !isInviteLeak(message.content)) return;
    const removed = await tryAsync(
        () =>
            deps.api.channels.deleteMessage(message.channel_id, message.id, {
                reason: "discord invite",
            }),
        (cause) => cause,
    );
    // Already gone (its author or a moderator was quicker) is as good as removed.
    if (
        !removed.ok &&
        !(removed.error instanceof DiscordAPIError && removed.error.code === 10008)
    ) {
        deps.logger.write("warn", "invite removal failed", {
            origin: "guard",
            detail: describeUnknownError(removed.error),
        });
        return;
    }
    // Who and where, never the text.
    deps.logger.write("info", "invite removed", {
        origin: "guard",
        detail: `user ${message.author.id} in channel ${message.channel_id}`,
    });
}
