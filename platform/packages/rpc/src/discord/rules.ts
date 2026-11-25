import { ProductId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";

// A Discord id (user, role, channel, message): a snowflake in decimal, past JSON's safe integers.
export const Snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
export type Snowflake = z.output<typeof Snowflake>;

// Who a role rule gives its Discord role to, among linked accounts in good standing: every one,
// those entitled to a product now, or those holding a site role now.
export const RoleCondition = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("linked") }),
    z.strictObject({ kind: z.literal("entitled"), productId: ProductId }),
    z.strictObject({ kind: z.literal("holds_role"), roleId: RoleId }),
]);
export type RoleCondition = z.output<typeof RoleCondition>;

// What a feed channel is told: product status changes, newly published resources, and release
// promotions.
export const FeedKind = z.enum(["status", "resources", "releases"]);
export type FeedKind = z.output<typeof FeedKind>;

// One rule as staff set it: a Discord role and who gets it, a channel where staff reads may be
// answered, or a channel and the feed it gets.
export const RuleFields = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("role"), roleId: Snowflake, condition: RoleCondition }),
    z.strictObject({ kind: z.literal("staff_channel"), channelId: Snowflake }),
    z.strictObject({ kind: z.literal("feed"), channelId: Snowflake, feed: FeedKind }),
]);
export type RuleFields = z.output<typeof RuleFields>;

export const RuleId = z.uuid();
