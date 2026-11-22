import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ReadRefusal, refusal, StaffRefusals, WireId } from "./shared.ts";

const FactSetId = z.string().regex(/^[1-9][0-9]{0,18}$/);

// A game module build: its name hash as 16 hex digits, TimeDateStamp and SizeOfImage.
const ModuleBuild = z.object({
    nameHash: z.string().regex(/^[0-9a-f]{16}$/),
    timeDateStamp: z.number().int().nonnegative(),
    sizeOfImage: z.number().int().nonnegative(),
});

export const factsContract = defineContract({
    // A module release's fact sets: each build's current set, and the newest sets first.
    "admin.facts.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ releaseId: WireId }),
        output: z.object({
            releaseId: WireId,
            productId: z.string(),
            channel: z.string(),
            builds: z
                .array(
                    z.object({
                        build: ModuleBuild,
                        current: z
                            .object({
                                setId: FactSetId,
                                revision: z.number().int(),
                                promotedAt: EpochMs,
                            })
                            .nullable(),
                    }),
                )
                .readonly(),
            sets: z
                .array(
                    z.object({
                        setId: FactSetId,
                        revision: z.number().int(),
                        stagedAt: EpochMs,
                        builds: z.array(ModuleBuild).readonly(),
                    }),
                )
                .readonly(),
        }),
        error: ReadRefusal,
    },
    // Makes the set current for every build it lists. A set below the current revision of any of
    // them is refused; one current for all of them already changes nothing.
    "admin.facts.promote": {
        session: "member",
        effect: "write",
        input: z.strictObject({ releaseId: WireId, setId: FactSetId }),
        output: z.object({ changed: z.boolean() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            z.object({ code: z.literal("REVISION_BELOW_CURRENT"), current: z.number().int() }),
        ]),
    },
});
