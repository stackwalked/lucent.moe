import { ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { MemberRefusal } from "./inbox.ts";
import { Done, refusal, Unavailable } from "./shared.ts";

export const Channels = z.object({ inbox: z.boolean(), mail: z.boolean() });
export type Channels = z.output<typeof Channels>;
export const SetPreference = z.strictObject({
    kind: z.literal("product_status"),
    ...Channels.shape,
});
export const SetSubscription = z.strictObject({ productId: ProductId, following: z.boolean() });

export const preferencesContract = defineContract({
    "preferences.channels.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            security: Channels,
            product_status: Channels,
            subscriptions: z.array(ProductId).readonly(),
        }),
        error: MemberRefusal,
    },
    "preferences.channels.set": {
        session: "member",
        effect: "write",
        input: SetPreference,
        output: Done,
        error: MemberRefusal,
    },
    "preferences.subscriptions.set": {
        session: "member",
        effect: "write",
        input: SetSubscription,
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("SESSION_INVALID"),
            refusal("NOT_FOUND"),
        ]),
    },
});
