import { ProductState } from "@lucent/catalog/product";
import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { RestrictionKind } from "../web/community.ts";
import { Features, refusal, SealNumber, Unavailable } from "../web/shared.ts";
import { MessageBody, TicketId, TicketSubject } from "../web/tickets.ts";
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

// How the linked account stands. "unlinked" is also the answer for a Discord user nobody linked:
// it says nothing about whether any account exists. Suspended and locked accounts get no detail.
const Unlinked = z.object({ standing: z.literal("unlinked") });
const Inactive = z.object({ standing: z.enum(["suspended", "locked"]) });

// One product as products.list shows it to the account.
const MemberProduct = z.object({
    productId: ProductId,
    name: z.string(),
    state: ProductState,
    features: Features,
    channels: z
        .array(
            z.object({
                channel: ChannelId,
                release: z.object({ promotedAt: EpochMs, supported: z.boolean() }).nullable(),
            }),
        )
        .readonly(),
});

const PublicStatus = z.object({
    product: z.string(),
    state: z.enum(["announced", "live"]),
    supported: z.boolean().nullable(),
});

export const DmOutcome = z.enum(["sent", "refused", "failed"]);

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
    // `/me`: what the site shows the linked account, in one answer: its products and channels as
    // products.list has them, its devices against its limit, the soonest end among its running
    // entitlements, and its posting restrictions as the privacy page lists them.
    "me.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({ userId: Snowflake }),
        output: z.discriminatedUnion("standing", [
            Unlinked,
            Inactive,
            z.object({
                standing: z.literal("active"),
                products: z.array(MemberProduct).readonly(),
                devices: z.object({ count: z.number().int(), limit: z.number().int() }),
                nextExpiry: EpochMs.nullable(),
                restrictions: z
                    .array(
                        z.object({
                            kind: RestrictionKind,
                            product: z.string().nullable(),
                            endsAt: EpochMs.nullable(),
                        }),
                    )
                    .readonly(),
            }),
        ]),
        error: Failure,
    },
    // `/status`: each product the public home lists, as the status feed says it.
    "status.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ products: z.array(PublicStatus).readonly() }),
        error: Failure,
    },
    // What /ticket's form offers the linked account: the products listed for it.
    "tickets.products": {
        session: "none",
        effect: "read",
        input: z.strictObject({ userId: Snowflake }),
        output: z.discriminatedUnion("standing", [
            Unlinked,
            Inactive,
            z.object({
                standing: z.literal("active"),
                products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
            }),
        ]),
        error: Failure,
    },
    // `/ticket`'s form: a help ticket for the linked account, through the site's own writer and
    // limits. `url` is its page on the site.
    "tickets.open": {
        session: "none",
        effect: "write",
        input: z.strictObject({
            userId: Snowflake,
            productId: ProductId.nullable(),
            subject: TicketSubject,
            body: MessageBody,
        }),
        output: z.object({ ticketId: TicketId, url: z.url() }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("NOT_LINKED"),
            refusal("ACCOUNT_UNAVAILABLE"),
            refusal("UNKNOWN_PRODUCT"),
            refusal("TICKET_LIMIT"),
        ]),
    },
    // Notices due as DMs, oldest first. Each says what kind of notice arrived (and for which
    // product), never its content, and links to the inbox.
    "dms.read": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            dms: z
                .array(
                    z.object({
                        id: z.string().regex(/^[1-9][0-9]{0,18}$/),
                        userId: Snowflake,
                        notice: z.discriminatedUnion("kind", [
                            z.object({ kind: z.literal("security") }),
                            z.object({ kind: z.literal("product_status"), product: z.string() }),
                        ]),
                        url: z.url(),
                    }),
                )
                .readonly(),
        }),
        error: Failure,
    },
    // How a DM went: sent, refused by Discord (DMs closed, the bot blocked: not tried again), or
    // failed some other way (tried again a few times, then dropped).
    "dms.settled": {
        session: "none",
        effect: "write",
        input: z.strictObject({ id: z.string().regex(/^[1-9][0-9]{0,18}$/), outcome: DmOutcome }),
        output: Done,
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
