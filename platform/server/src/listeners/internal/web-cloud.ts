import { err, type Result } from "@lucent/core/result";
import type { BearerToken, ProductId } from "@lucent/core/scalars";
import type { Handlers } from "@lucent/rpc/mount";
import type { cloudContract } from "@lucent/rpc/web/cloud";
import type { CloudLimits } from "../../cloud/items.rules.ts";
import { type CloudScope, changeItem, deleteItem, listItems } from "../../cloud/items.ts";
import type { CloudOperation } from "../../cloud/member.rules.ts";
import {
    createEmptyItem,
    itemHistory,
    listCloudProducts,
    withCloudScope,
} from "../../cloud/member.ts";
import { createShare, importShare, revokeShare } from "../../cloud/shares.ts";
import type { DbFailure, Tx } from "../../db/pool.ts";
import { done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

type RequestScope = { readonly productId: ProductId; readonly session: BearerToken };
type Appending = Extract<CloudOperation, "create" | "rename" | "restore" | "import">;
type Step = Result<unknown, { readonly code: string }>;
type Removed = DbFailure | { readonly code: "NOT_FOUND" };

async function scoped<S extends Step>(
    ctx: WebRpcContext,
    request: RequestScope & { readonly operation: CloudOperation },
    work: (tx: Tx, scope: CloudScope) => Promise<S>,
) {
    return served(await withCloudScope(ctx.auth.db, { catalog: ctx.catalog, ...request }, work));
}

// Check membership even if policy is unavailable; never substitute an unbounded quota.
function append<S extends Step>(
    ctx: WebRpcContext,
    request: RequestScope & { readonly operation: Appending },
    work: (tx: Tx, scope: CloudScope, limits: CloudLimits) => Promise<S>,
) {
    return scoped(ctx, request, async (tx, scope) => {
        if (ctx.cloudLimits === undefined) return err({ code: "SERVICE_UNAVAILABLE" });
        return await work(tx, scope, ctx.cloudLimits);
    });
}

export const cloudHandlers = {
    "cloud.products.list": async (ctx, _, { session }) =>
        served(
            mapOk(await listCloudProducts(ctx.auth.db, session, ctx.catalog), (products) => ({
                products,
                canAppend: ctx.cloudLimits !== undefined,
            })),
        ),
    "cloud.items.list": (ctx, { productId }, { session }) =>
        scoped(ctx, { session, productId, operation: "list" }, listItems),
    "cloud.items.create": (ctx, { productId, operationId, name, kind }, { session }) =>
        append(ctx, { session, productId, operation: "create" }, (tx, scope, limits) =>
            createEmptyItem(tx, { ...scope, operationId, name, kind, limits }),
        ),
    "cloud.items.history": (ctx, { productId, itemId }, { session }) =>
        scoped(ctx, { session, productId, operation: "history" }, (tx, scope) =>
            itemHistory(tx, { ...scope, itemId }),
        ),
    "cloud.items.rename": (ctx, { productId, itemId, base, name }, { session }) =>
        append(ctx, { session, productId, operation: "rename" }, (tx, scope, limits) =>
            changeItem(tx, { ...scope, itemId, base, limits, change: { type: "rename", name } }),
        ),
    "cloud.items.restore": (ctx, { productId, itemId, base, revision }, { session }) =>
        append(ctx, { session, productId, operation: "restore" }, (tx, scope, limits) =>
            changeItem(tx, {
                ...scope,
                itemId,
                base,
                limits,
                change: { type: "restore", revision },
            }),
        ),
    "cloud.items.delete": (ctx, { productId, itemId }, { session }) =>
        scoped(ctx, { session, productId, operation: "delete" }, async (tx, scope) =>
            done<Removed>(await deleteItem(tx, { ...scope, itemId })),
        ),
    "cloud.shares.create": (ctx, { productId, itemId }, { session }) =>
        scoped(ctx, { session, productId, operation: "share" }, (tx, scope) =>
            createShare(tx, { ...scope, itemId }, ctx.auth.rng),
        ),
    "cloud.shares.revoke": (ctx, { productId, shareId }, { session }) =>
        scoped(ctx, { session, productId, operation: "revoke" }, async (tx, scope) =>
            done<Removed>(await revokeShare(tx, scope, shareId)),
        ),
    "cloud.shares.import": (ctx, { productId, token }, { session }) =>
        append(ctx, { session, productId, operation: "import" }, (tx, scope, limits) =>
            importShare(tx, { ...scope, limits, token }),
        ),
} satisfies Handlers<WebRpcContext, typeof cloudContract>;
