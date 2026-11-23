import { ProductDefinition } from "@lucent/catalog/product";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { ReadRefusal } from "./shared.ts";

export const catalogContract = defineContract({
    "catalog.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        // The previous client strictly parses the product fields, so don't send state here.
        output: z
            .array(z.object(ProductDefinition.unwrap().shape).omit({ state: true }))
            .readonly(),
        error: z.never(),
    },
    "catalog.products.list": {
        session: "none",
        effect: "read",
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: z.never(),
    },
    "admin.entitlements.listProducts": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.array(ProductDefinition).readonly(),
        error: ReadRefusal,
    },
});
