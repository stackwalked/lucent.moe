import { expect, test } from "bun:test";
import { ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import { decideDeliveries } from "../src/notify/deliveries.rules.ts";

const productId = ProductId.parse("cs2");
const security: Notice = { kind: "security", productId: null };
const status: Notice = { kind: "product_status", productId };
const all = { inbox: true, mail: true, discord: true };
const both = { inbox: true, mail: true, discord: false };
const neither = { inbox: false, mail: false, discord: false };
const inbox = { inbox: true, mail: false, discord: false };
const mail = { inbox: false, mail: true, discord: false };
const discord = { inbox: false, mail: false, discord: true };

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
    ["security ignores opt-outs", security, chosen(neither), [], both],
    ["security does not need any settings", security, chosen(null), [], both],
    ["security goes to discord only when chosen for it", security, chosen(all), [], both],
    ["security's discord choice adds a DM", security, chosen(null, true), [], all],
    ["opting in alone does not follow a product", status, chosen(both), [], neither],
    [
        "following another product is not enough",
        status,
        chosen(all),
        [ProductId.parse("other")],
        neither,
    ],
    ["following defaults to inbox", status, chosen(null), [productId], inbox],
    ["following respects a mail-only choice", status, chosen(mail), [productId], mail],
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
    ["a ticket reply defaults to inbox and mail", reply, chosen(null), [], both],
    ["a ticket reply needs no follow", reply, chosen(neither), [], both],
    ["a ticket reply respects an inbox-only choice", reply, chosen(null, false, inbox), [], inbox],
    ["a ticket reply respects a mail-only choice", reply, chosen(null, false, mail), [], mail],
    ["a ticket reply respects every opt-out", reply, chosen(all, true, neither), [], neither],
    ["a ticket reply never goes to discord", reply, chosen(all, true, all), [], both],
] as const)("%s", (_name, notice, preferences, subscriptions, expected) => {
    expect(decideDeliveries(notice, preferences, subscriptions)).toEqual({
        ok: true,
        value: expected,
    });
});
