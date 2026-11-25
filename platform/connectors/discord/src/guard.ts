import type {
    API,
    GatewayMessageCreateDispatchData,
    GatewayMessageUpdateDispatchData,
} from "@discordjs/core";
import { DiscordAPIError } from "@discordjs/rest";
import { describeUnknownError, tryAsync } from "@lucent/core/contain";
import type { Logger } from "./log.ts";

// Invites to other Discord servers are taken down wherever members talk; staff channels are left
// alone, as is an invite to this guild itself. One pattern and nothing else: moderation beyond it
// is people and Discord's own AutoMod. lucent.moe's own invite codes join this when admission
// lands (packet 06). The lookbehind keeps a longer host (notdiscord.gg) from matching.
const DISCORD_INVITE = /(?<![\w-])(discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([\w-]+)/gi;

// dsc.gg is a third party's redirect: Discord can't say where it leads, so it is never ours.
export type Invite = { readonly code: string; readonly resolvable: boolean };

export function invitesIn(text: string): readonly Invite[] {
    return [...text.matchAll(DISCORD_INVITE)].map((match) => ({
        code: match[2] ?? "",
        resolvable: match[1]?.toLowerCase() !== "dsc.gg",
    }));
}

// More invites than this in one message is not someone sharing this guild's own.
const MOST_RESOLVED = 3;
// Discord's "unknown message": its author or a moderator was quicker.
const UNKNOWN_MESSAGE = 10_008;

type GuardDeps = {
    readonly api: API;
    readonly guildId: string;
    readonly staffChannels: () => ReadonlySet<string>;
    readonly logger: Logger;
};

// Each invite resolved by Discord to this guild. Anything Discord can't resolve (expired, a
// redirect, Discord unreachable) counts as foreign: the message goes.
async function allOurs(deps: GuardDeps, invites: readonly Invite[]): Promise<boolean> {
    if (invites.length > MOST_RESOLVED) return false;
    for (const invite of invites) {
        if (!invite.resolvable) return false;
        const resolved = await tryAsync(
            () => deps.api.invites.get(invite.code),
            (cause) => cause,
        );
        if (!resolved.ok || resolved.value.guild?.id !== deps.guildId) return false;
    }
    return true;
}

// Run on a message as posted and again on every edit, so an invite added afterwards is caught.
// A forwarded message carries its text in its snapshots, not its content.
export async function guardMessage(
    deps: GuardDeps,
    message: GatewayMessageCreateDispatchData | GatewayMessageUpdateDispatchData,
): Promise<void> {
    if (message.guild_id !== deps.guildId || message.author.bot === true) return;
    if (deps.staffChannels().has(message.channel_id)) return;
    const texts = [
        message.content,
        ...(message.message_snapshots ?? []).map((snapshot) => snapshot.message.content),
    ];
    const invites = texts.flatMap(invitesIn);
    if (invites.length === 0 || (await allOurs(deps, invites))) return;
    const removed = await tryAsync(
        () =>
            deps.api.channels.deleteMessage(message.channel_id, message.id, {
                reason: "discord invite",
            }),
        (cause) => cause,
    );
    if (removed.ok) {
        // Who and where, never the text.
        deps.logger.write("info", "invite removed", {
            origin: "guard",
            detail: `user ${message.author.id} in channel ${message.channel_id}`,
        });
        return;
    }
    if (removed.error instanceof DiscordAPIError && removed.error.code === UNKNOWN_MESSAGE) return;
    deps.logger.write("warn", "invite removal failed", {
        origin: "guard",
        detail: describeUnknownError(removed.error),
    });
}
