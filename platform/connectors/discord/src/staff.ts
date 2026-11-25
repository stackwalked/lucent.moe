import {
    ApplicationCommandOptionType,
    ApplicationCommandType,
    type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "@discordjs/core";
import type { RpcClient } from "@lucent/rpc/client";
import type { DiscordContract } from "@lucent/rpc/discord/contract";
import { REPLIES, STAFF_COPY } from "./copy.ts";
import type { Reply } from "./interactions.ts";

// Staff reads: answered only in a channel the rules mark staff, for a linked account whose role
// grants the read, decided by platform on every call. Nothing here hides a command or caches who
// may use it; Discord's own command permissions are left as staff set them in the guild.
export const WHO_IS_THIS = "who is this";

export const STAFF_COMMANDS: RESTPutAPIApplicationGuildCommandsJSONBody = [
    {
        name: "who",
        description: STAFF_COPY.whoCommand,
        type: ApplicationCommandType.ChatInput,
        options: [
            {
                name: "member",
                description: STAFF_COPY.whoMember,
                type: ApplicationCommandOptionType.User,
            },
            {
                name: "account",
                description: STAFF_COPY.whoAccount,
                type: ApplicationCommandOptionType.String,
                max_length: 64,
            },
        ],
    },
    { name: "brief", description: STAFF_COPY.briefCommand, type: ApplicationCommandType.ChatInput },
    {
        name: "releases",
        description: STAFF_COPY.releasesCommand,
        type: ApplicationCommandType.ChatInput,
    },
    { name: WHO_IS_THIS, type: ApplicationCommandType.User },
];

export type StaffAsk = { readonly userId: string; readonly channelId: string };
export type WhoTarget =
    | { readonly kind: "member"; readonly userId: string }
    | { readonly kind: "query"; readonly text: string };

export function createStaffReads(platform: RpcClient<DiscordContract>) {
    return {
        who: async (ask: StaffAsk, target: WhoTarget): Promise<Reply> => {
            const read = await platform.call("staff.who", { ...ask, target });
            if (!read.ok) {
                if (read.error.code === "FORBIDDEN") return { content: STAFF_COPY.refused };
                if (read.error.code === "NOT_FOUND") return { content: STAFF_COPY.notFound };
                return { content: REPLIES.unavailable };
            }
            const who = read.value;
            return {
                content: [
                    STAFF_COPY.whoHeading(who.username, who.status),
                    STAFF_COPY.roles(who.roles),
                    STAFF_COPY.licences(who.licences),
                    STAFF_COPY.devices(who.devices.count, who.devices.limit),
                    STAFF_COPY.lastSeen(who.lastSeenAt),
                    STAFF_COPY.lastSession(who.lastSession),
                    ...(who.inReview ? [STAFF_COPY.inReview] : []),
                    ...(who.discordUserId === null ? [] : [STAFF_COPY.discord(who.discordUserId)]),
                    STAFF_COPY.accountId(who.accountId),
                ].join("\n"),
                link: { label: STAFF_COPY.openAccount, url: who.url },
            };
        },
        brief: async (ask: StaffAsk): Promise<Reply> => {
            const read = await platform.call("staff.brief", ask);
            if (!read.ok) {
                return {
                    content:
                        read.error.code === "FORBIDDEN" ? STAFF_COPY.refused : REPLIES.unavailable,
                };
            }
            return {
                content: STAFF_COPY.brief(read.value),
                link: { label: STAFF_COPY.openSystem, url: read.value.url },
            };
        },
        releases: async (ask: StaffAsk): Promise<Reply> => {
            const read = await platform.call("staff.releases", ask);
            if (!read.ok) {
                return {
                    content:
                        read.error.code === "FORBIDDEN" ? STAFF_COPY.refused : REPLIES.unavailable,
                };
            }
            return {
                content:
                    read.value.lines.length === 0
                        ? STAFF_COPY.noReleases
                        : read.value.lines.map(STAFF_COPY.release).join("\n"),
                link: { label: STAFF_COPY.openReleases, url: read.value.url },
            };
        },
    };
}
