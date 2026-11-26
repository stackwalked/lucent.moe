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
import { coversCoreFacts, StartModules, toModulesJson } from "../runtime/starts.ts";
import { decideSupportMove } from "./support.rules.ts";

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

// The recorded state moves only on events, never on whichever build the last start happened to
// report (game_build_report is one row per product that every start overwrites, so members on
// the old and the new build would flip it back and forth). A drop: a start reports a build no
// start reported before and the first channel's release doesn't cover the start's builds, or a
// release promoted on the first channel doesn't cover the game's builds. A rise: a promotion
// after which the first channel's release covers the builds the open drop was recorded on.
//
// Lock order: under the build coverage lock (facts/coverage-lock.ts), then the product_support
// row, written guarded by the state it held so two writers seeing the same move record it once;
// the change row is append-only.

async function readOpenDrop(tx: Tx, productId: string) {
    return await queryOne(
        tx,
        // Built here, not at load: runtime/starts.ts imports this module.
        z.object({ channel: z.string(), builds: StartModules }),
        sql`select channel, builds from product_support
            where product_id = ${productId} and not supported`,
    );
}

async function appendChange(
    tx: Tx,
    params: { readonly productId: string; readonly supported: boolean; readonly at: string },
): Promise<Result<void, DbFailure>> {
    const changed = await execute(
        tx,
        sql`insert into product_support_change (product_id, supported, changed_at, notified_at)
            values (${params.productId}, ${params.supported}, ${params.at}::timestamptz,
                    ${params.supported ? params.at : null}::timestamptz)`,
    );
    return changed.ok ? ok(undefined) : changed;
}

async function recordDrop(
    tx: Tx,
    params: {
        readonly productId: string;
        readonly channel: string;
        readonly builds: readonly ModuleKey[];
        readonly txNow: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const at = toTimestamptz(params.txNow);
    const stored = await queryAll(
        tx,
        z.object({ product_id: z.string() }),
        sql`insert into product_support (product_id, channel, supported, builds, changed_at)
            values (${params.productId}, ${params.channel}, false,
                    ${toModulesJson(params.builds)}::jsonb, ${at}::timestamptz)
            on conflict (product_id) do update
            set channel = excluded.channel, supported = false, builds = excluded.builds,
                changed_at = excluded.changed_at
            where product_support.supported
            returning product_id`,
    );
    if (!stored.ok) return stored;
    if (stored.value.length === 0) return ok(undefined);
    return await appendChange(tx, { productId: params.productId, supported: false, at });
}

async function recordRise(
    tx: Tx,
    params: { readonly productId: string; readonly txNow: EpochMs },
): Promise<Result<void, DbFailure>> {
    const at = toTimestamptz(params.txNow);
    const stored = await queryAll(
        tx,
        z.object({ product_id: z.string() }),
        sql`update product_support set supported = true, builds = null, changed_at = ${at}::timestamptz
            where product_id = ${params.productId} and not supported
            returning product_id`,
    );
    if (!stored.ok) return stored;
    if (stored.value.length === 0) return ok(undefined);
    return await appendChange(tx, { productId: params.productId, supported: true, at });
}

// After a start recorded its builds. `newlySeen`: how many of them no start had reported before;
// with none, nothing here runs a query. `covered` is the start's own coverage result, reused when
// it started on the first channel.
export async function recordSupportAfterReport(
    tx: Tx,
    params: {
        readonly product: ProductDefinition;
        readonly channel: string;
        readonly newlySeen: number;
        readonly covered: boolean;
        readonly modules: readonly ModuleKey[];
        readonly txNow: EpochMs;
    },
): Promise<Result<void, DbFailure>> {
    const { product } = params;
    const [first] = product.channels;
    if (params.newlySeen === 0 || product.state !== "live" || product.kind !== "module") {
        return ok(undefined);
    }
    if (first === undefined) return ok(undefined);
    let covered = params.covered;
    if (params.channel !== first) {
        const release = await findCurrentRelease(tx, { productId: product.id, channel: first });
        if (!release.ok) return release;
        if (release.value === null) return ok(undefined);
        const judged = await coversCoreFacts(tx, release.value.id, params.modules);
        if (!judged.ok) return judged;
        covered = judged.value;
    }
    const move = decideSupportMove({ down: false, event: "first_report", covered });
    if (move.value !== "drop") return ok(undefined);
    return await recordDrop(tx, {
        productId: product.id,
        channel: first,
        builds: params.modules,
        txNow: params.txNow,
    });
}

// After a fact set promotion: a rise when the open drop's builds are now covered on its channel.
// A product with no open drop costs one indexed read.
export async function recordSupportAfterFactPromotion(
    tx: Tx,
    params: { readonly productId: string; readonly txNow: EpochMs },
): Promise<Result<void, DbFailure>> {
    const open = await readOpenDrop(tx, params.productId);
    if (!open.ok) return open;
    if (open.value === null) return ok(undefined);
    const release = await findCurrentRelease(tx, {
        productId: params.productId,
        channel: open.value.channel,
    });
    if (!release.ok) return release;
    if (release.value === null) return ok(undefined);
    const covered = await coversCoreFacts(tx, release.value.id, open.value.builds);
    if (!covered.ok) return covered;
    const move = decideSupportMove({
        down: true,
        event: "fact_promotion",
        covered: covered.value,
    });
    if (move.value !== "rise") return ok(undefined);
    return await recordRise(tx, params);
}
