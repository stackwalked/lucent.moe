import type { ProductCatalog } from "@lucent/catalog/catalog";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import { type BearerToken, ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { readSession, type SessionInvalid } from "../auth/sessions.ts";
import { type FeatureSelection, readEffectiveProductAccess } from "../authority/entitlements.ts";
import { type Db, type DbFailure, queryAll, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";

export type MemberProduct = {
    readonly productId: ProductId;
    readonly name: string;
    readonly kind: ProductDefinition["kind"];
    readonly features: FeatureSelection;
    readonly channels: readonly {
        readonly channel: ChannelId;
        readonly release: { readonly promotedAt: EpochMs } | null;
    }[];
};

// What the member may run now, for their products page: the same effective access a start is
// checked against, and which of those channels has a release promoted. Whether the game's current
// build is supported needs fact sets, which this doesn't know of yet.
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
            z.object({ product_id: ProductId, channel: ChannelId, promoted_at: EpochMs }),
            sql`select product_id, channel, promoted_at from current_release`,
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
            products.push({
                productId: product.id,
                name: product.name,
                kind: product.kind,
                features: access.value.features,
                channels: access.value.channels.map((channel) => {
                    const current = promoted.value.find(
                        (row) => row.product_id === product.id && row.channel === channel,
                    );
                    return {
                        channel,
                        release: current === undefined ? null : { promotedAt: current.promoted_at },
                    };
                }),
            });
        }
        return ok(products);
    });
}
