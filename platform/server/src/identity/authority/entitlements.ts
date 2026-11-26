import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import {
    type AccountId,
    ChannelId,
    type EpochMs,
    FeatureTag,
    ProductId,
} from "@lucent/core/scalars";
import { z } from "zod";
import {
    type DbFailure,
    type Queryable,
    queryAll,
    sql,
    toTimestamptz,
} from "../../base/db/pool.ts";

export type FeatureSelection = "*" | readonly FeatureTag[];

export type ActiveProductGrant = {
    readonly features: FeatureSelection;
    readonly channels: readonly ChannelId[];
};

export type EffectiveProductAccess = {
    readonly isEntitled: boolean;
    readonly features: FeatureSelection;
    readonly channels: readonly ChannelId[];
};

export function computeEffectiveAccess(params: {
    readonly product: ProductDefinition;
    readonly grants: readonly ActiveProductGrant[];
    readonly roleChannels: readonly ChannelId[];
}): EffectiveProductAccess {
    if (params.grants.length === 0) {
        return {
            isEntitled: false,
            features: [],
            channels: [],
        };
    }

    let wildcardFeatures = false;
    const featureSet = new Set<FeatureTag>();
    const rawChannels = new Set<ChannelId>();

    for (const grant of params.grants) {
        if (grant.features === "*") {
            wildcardFeatures = true;
        } else {
            for (const tag of grant.features) {
                featureSet.add(tag);
            }
        }
        for (const ch of grant.channels) {
            rawChannels.add(ch);
        }
    }

    for (const ch of params.roleChannels) {
        rawChannels.add(ch);
    }

    // Preserve the product's declared channel precedence order.
    const orderedChannels = params.product.channels.filter((ch) => rawChannels.has(ch));
    const sortedFeatures = [...featureSet].sort();

    return {
        isEntitled: true,
        features: wildcardFeatures ? "*" : sortedFeatures,
        channels: orderedChannels,
    };
}

const FeaturesJsonSchema = z.union([z.literal("*"), z.array(FeatureTag)]);

const ActiveGrantRowSchema = z.object({
    features: FeaturesJsonSchema,
    channels: z.array(ChannelId),
});

const RoleChannelGrantSchema = z.object({
    productId: ProductId,
    channels: z.array(ChannelId),
});

const RoleChannelsRowSchema = z.object({
    channel_grants: z.array(RoleChannelGrantSchema),
});

export async function readEffectiveProductAccess(
    q: Queryable,
    params: {
        readonly accountId: AccountId;
        readonly product: ProductDefinition;
        readonly at: EpochMs | "transaction";
    },
): Promise<Result<EffectiveProductAccess, DbFailure>> {
    // A PostgreSQL deadline may carry microseconds. For a current membership check, comparing
    // to the database's transaction timestamp avoids reviving it in the last rounded millisecond.
    const at =
        params.at === "transaction" ? sql`now()` : sql`${toTimestamptz(params.at)}::timestamptz`;

    const grantsRes = await queryAll(
        q,
        ActiveGrantRowSchema,
        sql`select ep.features, ep.channels
            from entitlement e
            join entitlement_product ep on ep.entitlement_id = e.id
            join account a on a.id = e.account_id
            where e.account_id = ${params.accountId}
              and a.status = 'active'
              and e.status = 'active'
              and e.valid_from <= ${at}
              and (e.valid_until is null or e.valid_until > ${at})
              and ep.product_id = ${params.product.id}`,
    );
    if (!grantsRes.ok) return grantsRes;

    const rolesRes = await queryAll(
        q,
        RoleChannelsRowSchema,
        sql`select r.channel_grants
            from account_role ar
            join role r on r.id = ar.role_id
            where ar.account_id = ${params.accountId}
              and (ar.expires_at is null or ar.expires_at > ${at})`,
    );
    if (!rolesRes.ok) return rolesRes;

    const roleChannels: ChannelId[] = [];
    for (const row of rolesRes.value) {
        for (const entry of row.channel_grants) {
            if (entry.productId === params.product.id) {
                roleChannels.push(...entry.channels);
            }
        }
    }

    return ok(
        computeEffectiveAccess({
            product: params.product,
            grants: grantsRes.value,
            roleChannels,
        }),
    );
}
