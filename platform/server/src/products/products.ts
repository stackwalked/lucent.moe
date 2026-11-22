import type { ModuleKey } from "@lucent/bundle/fact-set";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import { type BearerToken, ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { readSession, type SessionInvalid } from "../auth/sessions.ts";
import { type FeatureSelection, readEffectiveProductAccess } from "../authority/entitlements.ts";
import { type Db, type DbFailure, type Queryable, queryAll, queryOne, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { coversCoreFacts, StartModules } from "../runtime/starts.ts";

export type MemberProduct = {
    readonly productId: ProductId;
    readonly name: string;
    readonly kind: ProductDefinition["kind"];
    readonly features: FeatureSelection;
    readonly channels: readonly {
        readonly channel: ChannelId;
        // `supported`: a start with the game's builds would pass core coverage now.
        readonly release: { readonly promotedAt: EpochMs; readonly supported: boolean } | null;
    }[];
};

// The builds the game has now, as far as the server knows: the ones the latest start on the
// product reported, refused or not. Before any start, the builds the release's current sets list.
async function readGameBuilds(
    q: Queryable,
    params: { readonly productId: ProductId; readonly releaseId: Uint8Array },
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

// What the member may run now, for their products page: the same effective access a start is
// checked against, which of those channels has a release promoted, and whether that release's
// current fact sets cover the game's builds by the start's own rule (runtime/starts.ts).
export async function listMemberProducts(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly sessionToken: BearerToken },
): Promise<Result<readonly MemberProduct[], SessionInvalid | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const session = await readSession(tx, {
            token: params.sessionToken,
            txNow,
            purposes: ["member"],
        });
        if (!session.ok) return session;
        const promoted = await queryAll(
            tx,
            z.object({
                product_id: ProductId,
                channel: ChannelId,
                promoted_at: EpochMs,
                release_id: z.instanceof(Uint8Array),
            }),
            sql`select c.product_id, c.channel, c.promoted_at, s.release_id
                from current_release c
                join release_seal s on s.product_id = c.product_id and s.channel = c.channel
                                   and s.number = c.number`,
        );
        if (!promoted.ok) return promoted;

        const products: MemberProduct[] = [];
        for (const product of params.catalog.values()) {
            const access = await readEffectiveProductAccess(tx, {
                accountId: session.value.accountId,
                product,
                at: txNow,
            });
            if (!access.ok) return access;
            if (!access.value.isEntitled || access.value.channels.length === 0) continue;
            const channels: MemberProduct["channels"][number][] = [];
            for (const channel of access.value.channels) {
                const current = promoted.value.find(
                    (row) => row.product_id === product.id && row.channel === channel,
                );
                if (current === undefined) {
                    channels.push({ channel, release: null });
                    continue;
                }
                let supported = true;
                if (product.kind === "module") {
                    const builds = await readGameBuilds(tx, {
                        productId: product.id,
                        releaseId: current.release_id,
                    });
                    if (!builds.ok) return builds;
                    const covered = await coversCoreFacts(tx, current.release_id, builds.value);
                    if (!covered.ok) return covered;
                    supported = covered.value;
                }
                channels.push({ channel, release: { promotedAt: current.promoted_at, supported } });
            }
            products.push({
                productId: product.id,
                name: product.name,
                kind: product.kind,
                features: access.value.features,
                channels,
            });
        }
        return ok(products);
    });
}
