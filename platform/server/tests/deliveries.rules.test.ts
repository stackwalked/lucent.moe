import { expect, test } from "bun:test";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import { decideDeliveries } from "../src/members/notify/deliveries.rules.ts";

const productId = ProductId.parse("cs2");
const security: Notice = { kind: "security", productId: null };
const status: Notice = { kind: "product_status", productId };
const all = { inbox: true, discord: true };
const inbox = { inbox: true, discord: false };
const neither = { inbox: false, discord: false };
const discord = { inbox: false, discord: true };

const ending: Notice = {
    kind: "subscription_ending",
    productId,
    endsAt: EpochMs.parse(1_800_000_000_000),
};

const reply: Notice = {
    kind: "ticket_reply",
    productId: null,
    ticketId: "00000000-0000-4000-8000-000000000001",
};

const chosen = (
    productStatus: typeof all | null,
    securityDiscord = false,
    ticketReply: typeof all | null = null,
) => ({ productStatus, ticketReply, securityDiscord });

test.each([
    ["security ignores opt-outs", security, chosen(neither), [], inbox],
    ["security does not need any settings", security, chosen(null), [], inbox],
    ["security goes to discord only when chosen for it", security, chosen(all), [], inbox],
    ["security's discord choice adds a DM", security, chosen(null, true), [], all],
    ["opting in alone does not follow a product", status, chosen(inbox), [], neither],
    [
        "following another product is not enough",
        status,
        chosen(all),
        [ProductId.parse("other")],
        neither,
    ],
    ["following defaults to inbox", status, chosen(null), [productId], inbox],
    ["following respects an inbox-only choice", status, chosen(inbox), [productId], inbox],
    ["following respects a discord-only choice", status, chosen(discord), [productId], discord],
    ["following respects every channel", status, chosen(all), [productId], all],
    ["following respects every opt-out", status, chosen(neither), [productId], neither],
    [
        "security's discord choice says nothing of products",
        status,
        chosen(null, true),
        [productId],
        inbox,
    ],
    ["a ticket reply defaults to inbox", reply, chosen(null), [], inbox],
    ["a ticket reply needs no follow", reply, chosen(neither), [], inbox],
    [
        "a ticket reply respects an inbox-off choice",
        reply,
        chosen(null, false, neither),
        [],
        neither,
    ],
    ["an ending subscription needs no follow and no setting", ending, chosen(neither), [], inbox],
    [
        "an ending subscription goes to discord on the member's one switch",
        ending,
        chosen(null, true),
        [],
        all,
    ],
    ["a ticket reply never goes to discord", reply, chosen(all, true, all), [], inbox],
] as const)("%s", (_name, notice, preferences, subscriptions, expected) => {
    expect(decideDeliveries(notice, preferences, subscriptions)).toEqual({
        ok: true,
        value: expected,
    });
});
