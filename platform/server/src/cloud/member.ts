import type { ProductCatalog } from "@lucent/catalog/catalog";
import { decideProductLifecycle } from "@lucent/catalog/lifecycle.rules";
import { err, ok, type Result } from "@lucent/core/result";
import type { AccountId, BearerToken, OperationId, ProductId } from "@lucent/core/scalars";
import { CloudId } from "@lucent/rpc/cloud-item";
import { z } from "zod";
import { lockSession } from "../auth/sessions.ts";
import { readEffectiveProductAccess } from "../authority/entitlements.ts";
import { type Db, execute, sql, type Tx } from "../db/pool.ts";
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

async function eligibleProducts(tx: Tx, catalog: ProductCatalog, accountId: AccountId) {
    const products: { id: ProductId; name: string }[] = [];
    for (const product of catalog.values()) {
        if (decideProductLifecycle(product.state, "current").value.startRefusal !== null) continue;
        const access = await readEffectiveProductAccess(tx, {
            accountId,
            product,
            at: "transaction",
        });
        if (!access.ok) return access;
        if (access.value.isEntitled) products.push({ id: product.id, name: product.name });
    }
    return ok(products);
}

export function listCloudProducts(db: Db, session: BearerToken, catalog: ProductCatalog) {
    return withCloudMember(db, session, (tx, accountId) =>
        eligibleProducts(tx, catalog, accountId),
    );
}

// Resolve even a guessed product through the same locked membership read as the selector.
export function withCloudScope<S extends Result<unknown, unknown>>(
    db: Db,
    params: {
        readonly session: BearerToken;
        readonly catalog: ProductCatalog;
        readonly productId: ProductId;
    },
    work: (tx: Tx, scope: CloudScope) => Promise<S>,
) {
    return withCloudMember(db, params.session, async (tx, accountId) => {
        const products = await eligibleProducts(tx, params.catalog, accountId);
        if (!products.ok) return products;
        if (!products.value.some((p) => p.id === params.productId))
            return err({ code: "NOT_FOUND" });
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
