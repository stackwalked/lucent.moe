import { ProductDefinition } from "@lucent/catalog/product";
import { z } from "zod";
import { defineContract } from "../contract.ts";

export const catalogContract = defineContract({
    "catalog.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: z.never(),
    },
});
