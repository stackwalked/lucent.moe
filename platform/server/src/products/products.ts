import type { ModuleKey } from "@lucent/bundle/fact-set";
import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import { type BearerToken, ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { readSession, type SessionInvalid } from "../auth/sessions.ts";
import type { FeatureSelection } from "../authority/entitlements.ts";
import { readAsStaff } from "../authority/staff.ts";
import { type Db, type DbFailure, type Queryable, queryAll, queryOne, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";
import { coversCoreFacts, StartModules } from "../runtime/starts.ts";
import { readMemberProduct } from "./visibility.ts";

export type MemberProduct = {
    readonly productId: ProductId;
    readonly name: string;
    readonly kind: ProductDefinition["kind"];
    readonly state: ProductDefinition["state"];
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

// Whether a start on this release with the game's builds would pass core coverage now.
export async function readReleaseSupported(
    q: Queryable,
    params: { readonly productId: ProductId; readonly releaseId: Uint8Array },
): Promise<Result<boolean, DbFailure>> {
    const builds = await readGameBuilds(q, params);
    if (!builds.ok) return builds;
    return await coversCoreFacts(q, params.releaseId, builds.value);
}

export function listPublicProducts(catalog: ProductCatalog): readonly ProductDefinition[] {
    return [...catalog.values()].filter((p) => decideProductLifecycle(p.state).value.listed);
}

export function listIssuableProducts(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly caller: Caller },
) {
    return readAsStaff<readonly ProductDefinition[], never>(
        db,
        { caller: params.caller, actions: ["entitlements:issue"] },
        () =>
            Promise.resolve(
                ok(
                    [...params.catalog.values()].filter(
                        (p) => decideProductLifecycle(p.state).value.issuable,
                    ),
                ),
            ),
    );
}

// History can make a product visible, but only current access can supply channels or features.
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
            const memberProduct = await readMemberProduct(tx, {
                accountId: session.value.accountId,
                product,
            });
            if (!memberProduct.ok) return memberProduct;
            const { access, lifecycle } = memberProduct.value;
            if (!lifecycle.listed) continue;
            const channels: MemberProduct["channels"][number][] = [];
            for (const channel of lifecycle.startRefusal === null ? access.channels : []) {
                const current = promoted.value.find(
                    (row) => row.product_id === product.id && row.channel === channel,
                );
                if (current === undefined) {
                    channels.push({ channel, release: null });
                    continue;
                }
                let supported = true;
                if (product.kind === "module") {
                    const covered = await readReleaseSupported(tx, {
                        productId: product.id,
                        releaseId: current.release_id,
                    });
                    if (!covered.ok) return covered;
                    supported = covered.value;
                }
                channels.push({ channel, release: { promotedAt: current.promoted_at, supported } });
            }
            products.push({
                productId: product.id,
                name: product.name,
                kind: product.kind,
                state: product.state,
                features: lifecycle.startRefusal === null ? access.features : [],
                channels,
            });
        }
        return ok(products);
    });
}
