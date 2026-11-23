import { z } from "zod";
import { CLOUD_ID_PATTERN, ITEM_KINDS, withinInt8 } from "./cloud-item-guards.ts";

// Separate from the procedure map: validating a route must not load every cloud RPC. The browser
// imports cloud-item-guards.ts, which keeps zod out of it too.
export const CloudId = z.string().regex(CLOUD_ID_PATTERN).refine(withinInt8);
export const ItemKind = z.enum(ITEM_KINDS);
