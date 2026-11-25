import type { ProductCatalog } from "@lucent/catalog/catalog";
import { ok, type Result } from "@lucent/core/result";
import { EpochMs, type ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { listPublicProducts } from "../products/products.ts";
import { decideRecoveries, type Recovery } from "./support.rules.ts";
import { readProductSupport } from "./support.ts";

// What anyone, signed out, may read of each product the public home lists: whether it works
// today and how long each game update took to recover from. A seed product is in no output.
// Nothing about accounts, sessions or counts of members.

// The newest recoveries per product, each a drop and its rise.
const RECOVERY_LIMIT = 20;

export type ProductStatus = {
    readonly productId: ProductId;
    readonly name: string;
    readonly state: "announced" | "live";
    // null: nothing to say yet (announced, or nothing promoted).
    readonly supported: boolean | null;
    readonly recoveries: readonly Recovery[];
};

export async function readPublicStatus(
    db: Db,
    params: { readonly catalog: ProductCatalog },
): Promise<Result<readonly ProductStatus[], DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const statuses: ProductStatus[] = [];
        for (const product of listPublicProducts(params.catalog)) {
            if (product.state !== "live" && product.state !== "announced") continue;
            const supported = await readProductSupport(tx, product);
            if (!supported.ok) return supported;
            const changes = await queryAll(
                tx,
                z.object({ supported: z.boolean(), changed_at: EpochMs }),
                sql`select supported, changed_at from product_support_change
                    where product_id = ${product.id}
                    order by id desc limit ${RECOVERY_LIMIT * 2 + 1}`,
            );
            if (!changes.ok) return changes;
            const recoveries = decideRecoveries({
                changes: changes.value
                    .toReversed()
                    .map((row) => ({ supported: row.supported, changedAt: row.changed_at })),
                txNow,
            });
            if (!recoveries.ok) return recoveries;
            statuses.push({
                productId: product.id,
                name: product.name,
                state: product.state,
                supported: supported.value,
                recoveries:
                    product.state === "live" ? recoveries.value.slice(0, RECOVERY_LIMIT) : [],
            });
        }
        return ok(statuses);
    });
}
