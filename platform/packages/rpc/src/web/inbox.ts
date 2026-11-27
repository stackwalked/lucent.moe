import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, pageOf, refusal, Unavailable } from "./shared.ts";
import { TicketId } from "./tickets.ts";

export const MemberRefusal = z.discriminatedUnion("code", [
    Unavailable,
    refusal("SESSION_INVALID"),
]);
export const InboxId = z.uuid();
const security = z.object({ kind: z.literal("security"), productId: z.null() });
const productStatus = z.object({ kind: z.literal("product_status"), productId: ProductId });
// Staff answered the member's help ticket. The entry names the ticket, never what was said.
const ticketReply = z.object({
    kind: z.literal("ticket_reply"),
    productId: z.null(),
    ticketId: TicketId,
});
// An entitlement of the member's ends at `endsAt`. The entry names the product only while the
// member may still see it; the notice itself (at record time) always has one.
const subscriptionEnding = z.object({
    kind: z.literal("subscription_ending"),
    productId: ProductId,
    endsAt: EpochMs,
});
export type Notice =
    | z.output<typeof security>
    | z.output<typeof productStatus>
    | z.output<typeof ticketReply>
    | z.output<typeof subscriptionEnding>;

const entry = { id: InboxId, createdAt: EpochMs, isRead: z.boolean() };
export const InboxEntry = z.discriminatedUnion("kind", [
    security.extend(entry),
    productStatus.extend(entry),
    ticketReply.extend(entry),
    subscriptionEnding.extend({ ...entry, productId: ProductId.nullable() }),
]);
export const inboxContract = defineContract({
    "inbox.entries.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ cursor: InboxId.nullable() }),
        output: pageOf(InboxEntry),
        error: MemberRefusal,
    },
    "inbox.unread.count": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ count: z.number().int().nonnegative() }),
        error: MemberRefusal,
    },
    "inbox.entries.read": {
        session: "member",
        effect: "write",
        input: z.strictObject({ id: InboxId }),
        output: Done,
        error: MemberRefusal,
    },
});
