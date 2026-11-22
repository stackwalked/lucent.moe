import { z } from "zod";
import { defineContract } from "../contract.ts";

export const healthContract = defineContract({
    "health.check": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ productsLoaded: z.number().int().nonnegative() }),
        error: z.never(),
    },
});
