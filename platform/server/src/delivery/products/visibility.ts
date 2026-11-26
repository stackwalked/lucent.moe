import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { ok } from "@lucent/core/result";
import type { AccountId, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { queryOne, sql, type Tx } from "../../base/db/pool.ts";
import { readEffectiveProductAccess } from "../../identity/authority/entitlements.ts";

export type MemberCatalog = { readonly accountId: AccountId; readonly catalog: ProductCatalog };

export async function readMemberProduct(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly product: ProductDefinition },
) {
    const access = await readEffectiveProductAccess(tx, { ...params, at: "transaction" });
    if (!access.ok) return access;
    const state = params.product.state;
    if (access.value.isEntitled)
        return ok({
            access: access.value,
            lifecycle: decideProductLifecycle(state, "current").value,
        });
    const history = await queryOne(
        tx,
        z.object({ held: z.boolean() }),
        sql`select true as held from entitlement_product ep join entitlement e on e.id = ep.entitlement_id
            where e.account_id = ${params.accountId} and ep.product_id = ${params.product.id}
              and e.valid_from <= now() limit 1`,
    );
    if (!history.ok) return history;
    return ok({
        access: access.value,
        lifecycle: decideProductLifecycle(state, history.value === null ? "none" : "past").value,
    });
}

export async function isListedForMember(tx: Tx, member: MemberCatalog, id: ProductId) {
    const product = member.catalog.get(id);
    if (product === undefined) return ok(false);
    if (decideProductLifecycle(product.state).value.listed) return ok(true);
    const result = await readMemberProduct(tx, { ...member, product });
    return result.ok ? ok(result.value.lifecycle.listed) : result;
}

export async function filterListedProducts(
    tx: Tx,
    member: MemberCatalog,
    ids: readonly ProductId[],
) {
    const listed: ProductId[] = [];
    for (const id of ids) {
        const visible = await isListedForMember(tx, member, id);
        if (!visible.ok) return visible;
        if (visible.value) listed.push(id);
    }
    return ok(listed);
}
