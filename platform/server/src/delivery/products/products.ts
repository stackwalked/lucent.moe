import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok, type Result } from "@lucent/core/result";
import {
    type AccountId,
    type BearerToken,
    ChannelId,
    EpochMs,
    ProductId,
} from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Db, type DbFailure, queryAll, sql, type Tx } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readSession, type SessionInvalid } from "../../identity/auth/sessions.ts";
import type { FeatureSelection } from "../../identity/authority/entitlements.ts";
import { readAsStaff } from "../../identity/authority/staff.ts";
import { readReleaseSupported } from "../../members/record/support.ts";
import { readMemberProduct } from "./visibility.ts";

export type MemberProduct = {
    readonly productId: ProductId;
    readonly name: string;
    readonly kind: ProductDefinition["kind"];
    readonly state: ProductDefinition["state"];
    // The member's latest-ending active entitlement to it (validUntil null: it does not end, and
    // a non-ending one wins), or null access when none is active now — the same test
    // readEffectiveProductAccess makes, account and revocation included.
    readonly access: { readonly validUntil: EpochMs | null } | null;
    readonly features: FeatureSelection;
    readonly channels: readonly {
        readonly channel: ChannelId;
        // `supported`: a start with the game's builds would pass core coverage now.
        readonly release: {
            readonly promotedAt: EpochMs;
            readonly supported: boolean;
            // The version of the changelog entry that names this release, if one does.
            readonly version: string | null;
        } | null;
    }[];
};

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
        return await readMemberProducts(tx, {
            catalog: params.catalog,
            accountId: session.value.accountId,
        });
    });
}

// What products.list shows the account, for whoever asks on its behalf (the Discord connector's
// /me answers from here, so it says what the site says).
export async function readMemberProducts(
    tx: Tx,
    params: { readonly catalog: ProductCatalog; readonly accountId: AccountId },
): Promise<Result<readonly MemberProduct[], DbFailure>> {
    const promoted = await queryAll(
        tx,
        z.object({
            product_id: ProductId,
            channel: ChannelId,
            promoted_at: EpochMs,
            release_id: z.instanceof(Uint8Array),
            version: z.string().nullable(),
        }),
        sql`select c.product_id, c.channel, c.promoted_at, s.release_id,
                   (select e.version from changelog_entry e where e.release_id = s.release_id)
                       as version
                from current_release c
                join release_seal s on s.product_id = c.product_id and s.channel = c.channel
                                   and s.number = c.number`,
    );
    if (!promoted.ok) return promoted;

    const entitlements = await queryAll(
        tx,
        z.object({
            product_id: ProductId,
            valid_until: EpochMs.nullable(),
        }),
        sql`select ep.product_id,
                   case when bool_or(e.valid_until is null) then null
                        else max(e.valid_until) end as valid_until
            from entitlement e
            join entitlement_product ep on ep.entitlement_id = e.id
            join account a on a.id = e.account_id
            where e.account_id = ${params.accountId}
              and a.status = 'active'
              and e.status = 'active'
              and e.valid_from <= now()
              and (e.valid_until is null or e.valid_until > now())
            group by ep.product_id`,
    );
    if (!entitlements.ok) return entitlements;

    const products: MemberProduct[] = [];
    for (const product of params.catalog.values()) {
        const memberProduct = await readMemberProduct(tx, {
            accountId: params.accountId,
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
            channels.push({
                channel,
                release: {
                    promotedAt: current.promoted_at,
                    supported,
                    version: current.version,
                },
            });
        }
        const held = entitlements.value.find((row) => row.product_id === product.id);
        products.push({
            productId: product.id,
            name: product.name,
            kind: product.kind,
            state: product.state,
            access: held === undefined ? null : { validUntil: held.valid_until },
            features: lifecycle.startRefusal === null ? access.features : [],
            channels,
        });
    }
    return ok(products);
}
