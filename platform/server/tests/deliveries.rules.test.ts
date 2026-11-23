import { expect, test } from "bun:test";
import { ProductId } from "@lucent/core/scalars";
import type { Notice } from "@lucent/rpc/web/inbox";
import { decideDeliveries } from "../src/notify/deliveries.rules.ts";

const productId = ProductId.parse("cs2");
const security: Notice = { kind: "security", productId: null };
const status: Notice = { kind: "product_status", productId };
const both = { inbox: true, mail: true };
const neither = { inbox: false, mail: false };
const inbox = { inbox: true, mail: false };
const mail = { inbox: false, mail: true };

test.each([
    ["security ignores opt-outs", security, neither, [], both],
    ["security does not need any settings", security, null, [], both],
    ["opting in alone does not follow a product", status, both, [], neither],
    ["following another product is not enough", status, both, [ProductId.parse("other")], neither],
    ["following defaults to inbox", status, null, [productId], inbox],
    ["following respects a mail-only choice", status, mail, [productId], mail],
    ["following respects an inbox-only choice", status, inbox, [productId], inbox],
    ["following respects both channels", status, both, [productId], both],
    ["following respects both opt-outs", status, neither, [productId], neither],
] as const)("%s", (_name, notice, preferences, subscriptions, expected) => {
    expect(decideDeliveries(notice, preferences, subscriptions)).toEqual({
        ok: true,
        value: expected,
    });
});
