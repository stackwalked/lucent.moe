import { EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { MemberRefusal } from "./inbox.ts";

export const RestrictionKind = z.enum(["muted", "barred"]);

// Refused when the account's community standing closes the place it tried to write. The reason
// staff gave is not part of it.
export const PostingRestricted = z.object({
    code: z.literal("POSTING_RESTRICTED"),
    kind: RestrictionKind,
    productId: ProductId.nullable(),
    endsAt: EpochMs.nullable(),
});

export const privacyContract = defineContract({
    "privacy.restrictions.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            restrictions: z
                .array(
                    z.object({
                        kind: RestrictionKind,
                        productId: ProductId.nullable(),
                        endsAt: EpochMs.nullable(),
                    }),
                )
                .readonly(),
        }),
        error: MemberRefusal,
    },
});
