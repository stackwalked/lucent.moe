import { z } from "zod";
import { defineContract } from "../contract.ts";
import { SealNumber, SessionRefusal } from "./shared.ts";

export const downloadContract = defineContract({
    // Whether the member may download the loader now: "no_product" without an entitlement to a
    // product other than the loader, "no_release" while none is promoted. The bytes come from the
    // internal listener's download route, not through RPC.
    "download.loader": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.discriminatedUnion("state", [
            z.object({
                state: z.literal("ready"),
                number: SealNumber,
                // The version of the entry that names the current loader release.
                version: z.string().nullable(),
            }),
            z.object({ state: z.literal("no_product") }),
            z.object({ state: z.literal("no_release") }),
        ]),
        error: SessionRefusal,
    },
});
