import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { StaffRefusals } from "./shared.ts";

const ModuleBuild = z.object({
    nameHash: z.string().regex(/^[0-9a-f]{16}$/),
    timeDateStamp: z.number().int().nonnegative(),
    sizeOfImage: z.number().int().nonnegative(),
});

export const updatesContract = defineContract({
    // Update-day latency per module build, newest report first: from the first start that reported
    // the build to the first promotion that covered it, or how long it has waited so far.
    "admin.updates.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            builds: z
                .array(
                    z.object({
                        productId: z.string(),
                        build: ModuleBuild,
                        firstReportedAt: EpochMs,
                        firstCoveredAt: EpochMs.nullable(),
                        latency: z.discriminatedUnion("state", [
                            z.object({ state: z.literal("covered"), latencyMs: z.number() }),
                            z.object({ state: z.literal("waiting"), waitingMs: z.number() }),
                        ]),
                    }),
                )
                .readonly(),
            // More builds were reported than the list holds.
            truncated: z.boolean(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
});
