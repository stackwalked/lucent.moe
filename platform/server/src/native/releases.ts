import { ok, type Result } from "@lucent/core/result";
import { z } from "zod";
import { type DbFailure, type Queryable, queryOne, sql } from "../db/pool.ts";

// The loader is a product of its own, released per channel like any other.
export const LOADER_PRODUCT = "lucent-loader";

const Bytes = z.instanceof(Uint8Array);

export type CurrentRelease = {
    readonly id: Uint8Array;
    // The promoted seal and its number.
    readonly seal: Uint8Array;
    readonly number: bigint;
    // A module's release carries one; the loader's doesn't.
    readonly hasContainer: boolean;
};

// The release a start on this product and channel gets now; null when none was promoted.
export async function findCurrentRelease(
    q: Queryable,
    params: { readonly productId: string; readonly channel: string },
): Promise<Result<CurrentRelease | null, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ id: Bytes, seal: Bytes, number: z.coerce.bigint(), has_container: z.boolean() }),
        sql`select r.id, s.seal, s.number, r.container is not null as has_container
            from current_release c
            join release_seal s on s.product_id = c.product_id and s.channel = c.channel
                               and s.number = c.number
            join release r on r.id = s.release_id
            where c.product_id = ${params.productId} and c.channel = ${params.channel}`,
    );
    if (!row.ok) return row;
    const found = row.value;
    return ok(
        found === null
            ? null
            : {
                  id: found.id,
                  seal: found.seal,
                  number: found.number,
                  hasContainer: found.has_container,
              },
    );
}

// A module release's manifest, current or not: a replaced release stays servable to the sessions
// still running on it.
export async function findReleaseManifest(
    q: Queryable,
    releaseId: Uint8Array,
): Promise<Result<Uint8Array | null, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ manifest: Bytes.nullable() }),
        sql`select manifest from release where id = ${releaseId}`,
    );
    if (!row.ok) return row;
    return ok(row.value?.manifest ?? null);
}
