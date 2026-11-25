import type { ModuleKey } from "@lucent/bundle/fact-set";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type DbFailure,
    execute,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { findCurrentRelease } from "../releases/reads.ts";
import { coversCoreFacts, StartModules } from "../runtime/starts.ts";
import { decideSupportWrite } from "./support.rules.ts";

// Whether a product works today: the one rule the member product page, the Discord status feed
// and the public status page share. A start passes core coverage when the release's current fact
// sets hold every core fact for the game's builds (runtime/starts.ts `coversCoreFacts`).

// The builds the game has now, as far as the server knows: the ones the latest start on the
// product reported, refused or not. Before any start, the builds the release's current sets list.
async function readGameBuilds(
    q: Queryable,
    params: { readonly productId: string; readonly releaseId: Uint8Array },
): Promise<Result<readonly ModuleKey[], DbFailure>> {
    const reported = await queryOne(
        q,
        z.object({ modules: StartModules }),
        sql`select modules from game_build_report where product_id = ${params.productId}`,
    );
    if (!reported.ok) return reported;
    if (reported.value !== null) return ok(reported.value.modules);
    const listed = await queryAll(
        q,
        z.object({
            name_hash: z.string(),
            time_date_stamp: z.coerce.number(),
            size_of_image: z.coerce.number(),
        }),
        sql`select name_hash::text as name_hash, time_date_stamp, size_of_image
            from current_fact_set where release_id = ${params.releaseId}`,
    );
    if (!listed.ok) return listed;
    return ok(
        listed.value.map((row) => ({
            nameHash: BigInt(row.name_hash),
            timeDateStamp: row.time_date_stamp,
            sizeOfImage: row.size_of_image,
        })),
    );
}

// Whether a start on this module release with the game's builds would pass core coverage now.
export async function readReleaseSupported(
    q: Queryable,
    params: { readonly productId: string; readonly releaseId: Uint8Array },
): Promise<Result<boolean, DbFailure>> {
    const builds = await readGameBuilds(q, params);
    if (!builds.ok) return builds;
    return await coversCoreFacts(q, params.releaseId, builds.value);
}

// A module product's support on one channel; null when nothing is promoted there.
async function readChannelSupported(
    q: Queryable,
    params: { readonly productId: string; readonly channel: string },
): Promise<Result<boolean | null, DbFailure>> {
    const release = await findCurrentRelease(q, params);
    if (!release.ok) return release;
    if (release.value === null) return ok(null);
    return await readReleaseSupported(q, {
        productId: params.productId,
        releaseId: release.value.id,
    });
}

// What the public says of a listed product: whether it works today, on its first channel; null
// when it has none to say (announced, or nothing promoted). Only a module carries facts.
export async function readProductSupport(
    q: Queryable,
    product: ProductDefinition,
): Promise<Result<boolean | null, DbFailure>> {
    const [channel] = product.channels;
    if (product.state !== "live" || channel === undefined) return ok(null);
    if (product.kind === "module") {
        return await readChannelSupported(q, { productId: product.id, channel });
    }
    const release = await findCurrentRelease(q, { productId: product.id, channel });
    if (!release.ok) return release;
    return ok(release.value === null ? null : true);
}

// Records a change of a module product's support state on its channel, once: the stored row is
// read unlocked and written only when the state moved, with a where clause on the state read, so
// of two writers seeing the same move one records it and the other finds nothing to write. A
// start that changes nothing takes no row lock. Called under the build coverage lock, by the
// start that reports builds and the promotion that covers them.
async function recordChannelSupport(
    tx: Tx,
    params: {
        readonly productId: string;
        readonly channel: string;
        readonly recorded: boolean | null;
        readonly txNow: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const now = await readChannelSupported(tx, params);
    if (!now.ok) return now;
    const write = decideSupportWrite({ recorded: params.recorded, now: now.value });
    if (write.value === null) return ok(undefined);
    const at = toTimestamptz(params.txNow);
    const { supported } = write.value;
    const stored = await queryAll(
        tx,
        z.object({ product_id: z.string() }),
        params.recorded === null
            ? sql`insert into product_support (product_id, channel, supported, changed_at)
                  values (${params.productId}, ${params.channel}, ${supported},
                          ${at}::timestamptz)
                  on conflict (product_id) do nothing
                  returning product_id`
            : sql`update product_support
                  set channel = ${params.channel}, supported = ${supported},
                      changed_at = ${at}::timestamptz
                  where product_id = ${params.productId} and supported = ${params.recorded}
                  returning product_id`,
    );
    if (!stored.ok) return stored;
    if (stored.value.length === 0 || !write.value.change) return ok(undefined);
    const changed = await execute(
        tx,
        sql`insert into product_support_change (product_id, supported, changed_at, notified_at)
            values (${params.productId}, ${supported}, ${at}::timestamptz,
                    ${supported ? at : null}::timestamptz)`,
    );
    if (!changed.ok) return changed;
    return ok(undefined);
}

const RecordedRow = z.object({ channel: z.string(), supported: z.boolean() });

// After a start recorded the builds it reported: a live module product's support on its first
// channel, which the builds may have moved.
export async function recordSupportAfterReport(
    tx: Tx,
    params: { readonly product: ProductDefinition; readonly txNow: EpochMs },
): Promise<Result<void, DbFailure>> {
    const { product } = params;
    const [channel] = product.channels;
    if (product.state !== "live" || product.kind !== "module" || channel === undefined) {
        return ok(undefined);
    }
    const recorded = await queryOne(
        tx,
        RecordedRow,
        sql`select channel, supported from product_support where product_id = ${product.id}`,
    );
    if (!recorded.ok) return recorded;
    // A product whose first channel changed is judged on the new one from here.
    return await recordChannelSupport(tx, {
        productId: product.id,
        channel,
        recorded: recorded.value?.supported ?? null,
        txNow: params.txNow,
    });
}

// After a promotion made sets current: the product's support on the channel its state was
// recorded on. A product no start has recorded is left for its next start, which brings the
// catalog's word on whether it is live.
export async function recordSupportAfterPromotion(
    tx: Tx,
    params: { readonly productId: string; readonly txNow: EpochMs },
): Promise<Result<void, DbFailure>> {
    const recorded = await queryOne(
        tx,
        RecordedRow,
        sql`select channel, supported from product_support where product_id = ${params.productId}`,
    );
    if (!recorded.ok) return recorded;
    if (recorded.value === null) return ok(undefined);
    return await recordChannelSupport(tx, {
        productId: params.productId,
        channel: recorded.value.channel,
        recorded: recorded.value.supported,
        txNow: params.txNow,
    });
}
