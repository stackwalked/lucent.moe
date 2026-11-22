import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ReadRefusal, refusal, SealNumber, StaffRefusals, WireId } from "./shared.ts";

const ReleaseLine = z.object({
    productId: ProductId,
    name: z.string(),
    kind: z.string(),
    channel: ChannelId,
    current: z.object({ number: SealNumber, promotedAt: EpochMs }).nullable(),
    seals: z
        .array(z.object({ number: SealNumber, releaseId: WireId, stagedAt: EpochMs }))
        .readonly(),
});

export const releasesContract = defineContract({
    // Every product and channel in catalog order, with its current seal and the seals at or above
    // it, highest first.
    "admin.releases.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ lines: z.array(ReleaseLine).readonly() }),
        error: ReadRefusal,
    },
    // Makes the seal current for its product and channel. One below the current seal is refused:
    // clients refuse a number below one they've seen. The current one again changes nothing.
    "admin.releases.promote": {
        session: "member",
        effect: "write",
        input: z.strictObject({ productId: ProductId, channel: ChannelId, number: SealNumber }),
        output: z.object({ changed: z.boolean() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            z.object({ code: z.literal("SEAL_BELOW_CURRENT"), current: SealNumber }),
        ]),
    },
});
