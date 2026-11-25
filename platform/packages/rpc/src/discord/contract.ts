import { ChannelId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { refusal, SealNumber, Unavailable } from "../web/shared.ts";
import { FeedKind, RuleId, Snowflake } from "./rules.ts";

// What the Discord connector may ask platform, on its own path and peer key: a call with its key
// to the web path, or naming a web procedure here, is refused. It acts for nobody. Who a Discord
// user is comes from the link table, by the user id Discord put in the interaction, never from a
// role seen in Discord. Outputs are written for what a Discord channel may show: no email, IP
// address or device id is in any of them.
export const DISCORD_RPC_PATH = "/internal/discord/rpc";

const Done = z.object({});
const Failure = z.discriminatedUnion("code", [Unavailable]);

// The audit position the connector has read up to, as a decimal id.
const Cursor = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

// A link code as a member types it: ten Crockford base32 characters, a dash allowed in the middle.
export const LinkCode = z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/);

// The roles the rules give one Discord user: none when the user is unlinked or the account is
// not in good standing.
const MemberRoles = z.object({ userId: Snowflake, roleIds: z.array(Snowflake).readonly() });

const Post = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("status"),
        product: z.string(),
        state: z.enum(["announced", "live"]),
        // Whether starts on the product's first channel pass core coverage now; null before a
        // release is promoted there, and for an announced product.
        supported: z.boolean().nullable(),
    }),
    z.object({
        kind: z.literal("resources"),
        title: z.string(),
        product: z.string().nullable(),
    }),
    z.object({
        kind: z.literal("releases"),
        product: z.string(),
        channel: ChannelId,
        number: SealNumber,
        promotedAt: EpochMs,
    }),
]);

export const discordContract = defineContract({
    // The site's origin for link buttons, and what the rules say: the Discord roles they manage
    // (a role in no rule is never touched) and the channels marked staff.
    "rules.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            siteOrigin: z.url(),
            managedRoleIds: z.array(Snowflake).readonly(),
            staffChannelIds: z.array(Snowflake).readonly(),
        }),
        error: Failure,
    },
    // The roles the rules give each of these users now. Unlinked users get none, as does an
    // account that is suspended or locked.
    "members.resolve": {
        session: "none",
        effect: "read",
        input: z.strictObject({ userIds: z.array(Snowflake).min(1).max(100) }),
        output: z.object({ members: z.array(MemberRoles).readonly() }),
        error: Failure,
    },
    // The Discord users whose roles may have changed since `after`, from the audit trail. Null
    // `after` starts at the end. `reconcile`: the rules changed, so every member is compared.
    // `retiredRoleIds`: Discord roles whose rule was just removed. `rules.read` no longer lists
    // them as managed, so that reconcile takes them off whoever the rule had given them to.
    "changes.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({ after: Cursor.nullable() }),
        output: z.object({
            cursor: Cursor,
            userIds: z.array(Snowflake).readonly(),
            reconcile: z.boolean(),
            retiredRoleIds: z.array(Snowflake).readonly(),
        }),
        error: Failure,
    },
    // `/link`: the account that issued the code becomes this Discord user's. CODE_INVALID for a
    // code that is unknown, expired or used; ALREADY_LINKED when either side has a link.
    "links.redeem": {
        session: "none",
        effect: "write",
        input: z.strictObject({ userId: Snowflake, code: LinkCode }),
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("CODE_INVALID"),
            refusal("ALREADY_LINKED"),
        ]),
    },
    // `/unlink`: whether there was a link to remove.
    "links.remove": {
        session: "none",
        effect: "write",
        input: z.strictObject({ userId: Snowflake }),
        output: z.object({ removed: z.boolean() }),
        error: Failure,
    },
    // What the feed channels have yet to be told, oldest first, at most a fixed number. Each post
    // carries the site page it links to.
    "feeds.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            posts: z
                .array(
                    z.object({
                        ruleId: RuleId,
                        channelId: Snowflake,
                        feed: FeedKind,
                        subject: z.string(),
                        state: z.string(),
                        url: z.url(),
                        post: Post,
                    }),
                )
                .readonly(),
        }),
        error: Failure,
    },
    // A post went out as `messageId`. A rule removed meanwhile records nothing.
    "feeds.posted": {
        session: "none",
        effect: "write",
        input: z.strictObject({
            ruleId: RuleId,
            subject: z.string().min(1).max(200),
            state: z.string().min(1).max(200),
            messageId: Snowflake,
        }),
        output: Done,
        error: Failure,
    },
});

export type DiscordContract = typeof discordContract;
