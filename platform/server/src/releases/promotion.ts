import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { ProductDefinition } from "@lucent/catalog/product";
import { err, ok, type Result } from "@lucent/core/result";
import { type ChannelId, EpochMs, type ProductId } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, lockAuthorized, readAsStaff } from "../authority/staff.ts";
import { appendAudit } from "../db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    toTimestamptz,
} from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { recordSupportAfterReleasePromotion } from "../record/support.ts";

// Promotion of staged releases. One current seal per product and channel; promoting one replaces
// the last. Seal numbers only rise: a client refuses a number below one it has seen signed, so a
// lower one made current would strand every member who updated. Going back is the old code signed
// again under a new number, which ops publishes like any other seal.

export type StagedSeal = {
    readonly number: string;
    readonly releaseId: string;
    readonly stagedAt: EpochMs;
};

export type ReleaseLine = {
    readonly productId: ProductId;
    readonly name: string;
    readonly kind: ProductDefinition["kind"];
    readonly channel: ChannelId;
    readonly current: { readonly number: string; readonly promotedAt: EpochMs } | null;
    // The current seal and every one above it, highest first: the ones promotion can still reach.
    readonly seals: readonly StagedSeal[];
};

const PROMOTERS = ["releases:promote", "facts:promote"] as const;

// Every product and channel in the catalog, in catalog order.
export async function listReleaseLines(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly caller: Caller },
): Promise<Result<readonly ReleaseLine[], Forbidden | DbFailure>> {
    return await readAsStaff(db, { caller: params.caller, actions: PROMOTERS }, async (q) => {
        const currents = await queryAll(
            q,
            z.object({
                product_id: z.string(),
                channel: z.string(),
                number: z.string(),
                promoted_at: EpochMs,
            }),
            sql`select product_id, channel, number::text as number, promoted_at
                from current_release`,
        );
        if (!currents.ok) return currents;
        const seals = await queryAll(
            q,
            z.object({
                product_id: z.string(),
                channel: z.string(),
                number: z.string(),
                release_id: z.string(),
                created_at: EpochMs,
            }),
            sql`select s.product_id, s.channel, s.number::text as number,
                       encode(s.release_id, 'hex') as release_id, s.created_at
                from release_seal s
                left join current_release c
                  on c.product_id = s.product_id and c.channel = s.channel
                where c.number is null or s.number >= c.number
                order by s.number desc`,
        );
        if (!seals.ok) return seals;
        const lines: ReleaseLine[] = [];
        for (const product of params.catalog.values()) {
            for (const channel of product.channels) {
                const current = currents.value.find(
                    (row) => row.product_id === product.id && row.channel === channel,
                );
                lines.push({
                    productId: product.id,
                    name: product.name,
                    kind: product.kind,
                    channel,
                    current:
                        current === undefined
                            ? null
                            : { number: current.number, promotedAt: current.promoted_at },
                    seals: seals.value
                        .filter((row) => row.product_id === product.id && row.channel === channel)
                        .map((row) => ({
                            number: row.number,
                            releaseId: row.release_id,
                            stagedAt: row.created_at,
                        })),
                });
            }
        }
        return ok(lines);
    });
}

export type PromoteReleaseRefusal =
    | AuthzRefusal
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "SEAL_BELOW_CURRENT"; readonly current: string };

// Promoting the seal that is already current changes nothing and records nothing.
export async function promoteRelease(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly caller: Caller;
        readonly productId: ProductId;
        readonly channel: ChannelId;
        readonly number: string;
    },
): Promise<Result<{ readonly changed: boolean }, PromoteReleaseRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: "releases:promote",
            txNow,
        });
        if (!authorized.ok) return authorized;
        const product = params.catalog.get(params.productId);
        if (product === undefined || !product.channels.includes(params.channel)) {
            return err({ code: "NOT_FOUND" as const });
        }
        // Two promotions of one line wait for each other, so each compares against the other's
        // result, including the first one, when there is no row to lock yet.
        const locked = await execute(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(
                    ${`lucent.release:${params.productId}:${params.channel}`}, 0))`,
        );
        if (!locked.ok) return locked;
        const seal = await queryOne(
            tx,
            z.object({ release_id: z.string() }),
            sql`select encode(release_id, 'hex') as release_id from release_seal
                where product_id = ${params.productId} and channel = ${params.channel}
                  and number = ${params.number}::bigint`,
        );
        if (!seal.ok) return seal;
        if (seal.value === null) return err({ code: "NOT_FOUND" as const });
        const current = await queryOne(
            tx,
            z.object({ number: z.string() }),
            sql`select number::text as number from current_release
                where product_id = ${params.productId} and channel = ${params.channel}`,
        );
        if (!current.ok) return current;
        const previous = current.value?.number ?? null;
        if (previous !== null) {
            const [wanted, held] = [BigInt(params.number), BigInt(previous)];
            if (wanted < held)
                return err({ code: "SEAL_BELOW_CURRENT" as const, current: previous });
            if (wanted === held) return ok({ changed: false });
        }
        const promoted = await execute(
            tx,
            sql`insert into current_release (product_id, channel, number, promoted_at)
                values (${params.productId}, ${params.channel}, ${params.number}::bigint,
                        ${toTimestamptz(txNow)}::timestamptz)
                on conflict (product_id, channel)
                do update set number = excluded.number, promoted_at = excluded.promoted_at`,
        );
        if (!promoted.ok) return promoted;
        const support = await recordSupportAfterReleasePromotion(tx, {
            product,
            channel: params.channel,
            releaseId: Uint8Array.fromHex(seal.value.release_id),
            txNow,
        });
        if (!support.ok) return support;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "release.promote",
            target: {
                productId: params.productId,
                channel: params.channel,
                number: params.number,
                releaseId: seal.value.release_id,
                previous,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ changed: true });
    });
}
