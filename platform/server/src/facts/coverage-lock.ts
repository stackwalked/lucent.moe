import { ok, type Result } from "@lucent/core/result";
import { type DbFailure, execute, sql, type Tx } from "../db/pool.ts";

// Serializes a start recording a product's builds with a promotion covering them, so the start
// either sees the promotion's current sets or the promotion sees the start's new row: otherwise a
// build's first coverage stays null for good. Keyed per product, not per release, because a build
// counts as covered by a promotion on any of the product's releases. Promotion takes it
// exclusively right after its release lock; starts take it shared, after the entitlement and
// before any slot or session row.
export async function lockBuildCoverage(
    tx: Tx,
    params: { readonly productId: string; readonly mode: "shared" | "exclusive" },
): Promise<Result<void, DbFailure>> {
    const key = `lucent.build-coverage:${params.productId}`;
    const locked = await execute(
        tx,
        params.mode === "shared"
            ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
            : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
    if (!locked.ok) return locked;
    return ok(undefined);
}
