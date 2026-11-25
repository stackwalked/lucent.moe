import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import type { ProductDefinition } from "@lucent/catalog/product";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId, BearerToken, OperationId, ProductId } from "@lucent/core/scalars";
import { CloudId } from "@lucent/rpc/cloud-item";
import { z } from "zod";
import { lockSession } from "../auth/sessions.ts";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import { type Db, execute, queryOne, sql, type Tx } from "../db/pool.ts";
import { readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { withTx } from "../db/tx.ts";
import type { CloudLimits } from "./items.rules.ts";
import {
    type CloudItem,
    type CloudScope,
    createItem,
    type ItemKind,
    listHistory,
} from "./items.ts";
import { type CloudOperation, decideCloudAccess } from "./member.rules.ts";
import { listShares } from "./shares.ts";

function withCloudMember<S extends Result<unknown, unknown>>(
    db: Db,
    token: BearerToken,
    work: (tx: Tx, accountId: AccountId) => Promise<S>,
) {
    return withTx(db, async (tx, txNow) => {
        const member = await lockSession(tx, { token, txNow, purposes: ["member"] });
        if (!member.ok) return member;
        // lockSession locks the account. Sign-out deletes just this token; pin it too,
        // after the account lock, until any share disclosure or import has committed.
        const active = await execute(
            tx,
            sql`select 1 from browser_session
            where token_hash = ${member.value.tokenHash} and account_id = ${member.value.accountId}
            and purpose = 'member' and expires_at > now() for share`,
        );
        if (!active.ok) return active;
        if (active.value === 0) return err({ code: "SESSION_INVALID" });
        return work(tx, member.value.accountId);
    });
}

// Whether the member could start the product today: its lifecycle allows a start and their
// entitlement holds now.
async function isEligible(tx: Tx, product: ProductDefinition, accountId: AccountId) {
    if (decideProductLifecycle(product.state, "current").value.startRefusal !== null) {
        return ok(false);
    }
    const access = await readEffectiveProductAccess(tx, { accountId, product, at: "transaction" });
    return access.ok ? ok(access.value.isEntitled) : access;
}

async function holdsItems(tx: Tx, accountId: AccountId, productId: ProductId) {
    const held = await queryOne(
        tx,
        z.object({ held: z.boolean() }),
        sql`select exists (select 1 from cloud_item
            where account_id = ${accountId} and product_id = ${productId}) as held`,
    );
    if (!held.ok) return held;
    invariant(held.value !== null, "a select without from yields its row");
    return ok(held.value.held);
}

// Each product the member could start or still holds items in; `canCreate` says which.
export function listCloudProducts(db: Db, session: BearerToken, catalog: ProductCatalog) {
    return withCloudMember(db, session, async (tx, accountId) => {
        const products: { id: ProductId; name: string; canCreate: boolean }[] = [];
        for (const product of catalog.values()) {
            const eligible = await isEligible(tx, product, accountId);
            if (!eligible.ok) return eligible;
            if (!eligible.value) {
                const held = await holdsItems(tx, accountId, product.id);
                if (!held.ok) return held;
                if (!held.value) continue;
            }
            products.push({ id: product.id, name: product.name, canCreate: eligible.value });
        }
        return ok(products);
    });
}

// Resolve even a guessed product through the same locked membership read as the selector.
export function withCloudScope<S extends Result<unknown, unknown>>(
    db: Db,
    params: {
        readonly session: BearerToken;
        readonly catalog: ProductCatalog;
        readonly productId: ProductId;
        readonly operation: CloudOperation;
    },
    work: (tx: Tx, scope: CloudScope) => Promise<S>,
) {
    return withCloudMember(db, params.session, async (tx, accountId) => {
        const product = params.catalog.get(params.productId);
        const eligible =
            product === undefined ? ok(false) : await isEligible(tx, product, accountId);
        if (!eligible.ok) return eligible;
        const held = await holdsItems(tx, accountId, params.productId);
        if (!held.ok) return held;
        const access = decideCloudAccess({
            operation: params.operation,
            eligible: eligible.value,
            holdsItems: held.value,
        });
        if (!access.ok) return access;
        return work(tx, { accountId, productId: params.productId });
    });
}
export async function itemHistory(tx: Tx, item: CloudItem) {
    const versions = await listHistory(tx, item);
    if (!versions.ok) return versions;
    if (versions.value.length === 0) return err({ code: "NOT_FOUND" });
    const shares = await listShares(tx, item);
    return shares.ok ? ok({ versions: versions.value, shares: shares.value }) : shares;
}

// The web form creates a named, empty item. No RPC input contains its opaque body.
export async function createEmptyItem(
    tx: Tx,
    params: CloudScope & {
        readonly operationId: OperationId;
        readonly name: string;
        readonly kind: z.output<typeof ItemKind>;
        readonly limits: CloudLimits;
    },
) {
    const { accountId, productId, operationId, name, kind } = params;
    const key = await toOperationKey({
        principal: `${accountId}/${productId}`,
        endpoint: "cloud.items.create",
        operationId,
        payload: { productId, name, kind },
    });
    const replay = await readReplay(tx, key, z.object({ itemId: CloudId }));
    if (!replay.ok) return replay;
    if (replay.value.replayed) return ok(replay.value.result);
    const item = await createItem(tx, { ...params, bytes: new Uint8Array(0) });
    if (!item.ok) return item;
    const result = { itemId: item.value.itemId };
    const recorded = await recordReceipt(tx, key, result);
    return recorded.ok ? ok(result) : recorded;
}
