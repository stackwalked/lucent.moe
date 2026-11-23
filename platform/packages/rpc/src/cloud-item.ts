import { z } from "zod";

// Separate from the procedure map: validating a browser route must not load every cloud RPC.
// PostgreSQL int8 identities travel as decimal strings, without rounding through JS numbers.
export const CloudId = z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((s) => s.length < 19 || s <= "9223372036854775807");
export const ItemKind = z.enum(["config", "inventory", "script"]);
