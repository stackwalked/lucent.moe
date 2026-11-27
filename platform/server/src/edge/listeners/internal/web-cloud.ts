import { err, type Result } from "@lucent/core/result";
import type { BearerToken, ProductId } from "@lucent/core/scalars";
import type { Handlers } from "@lucent/rpc/mount";
import type { cloudContract } from "@lucent/rpc/web/cloud";
import type { DbFailure, Tx } from "../../../base/db/pool.ts";
import type { CloudLimits } from "../../../delivery/cloud/items.rules.ts";
import { type CloudScope, changeItem, deleteItem } from "../../../delivery/cloud/items.ts";
import {
    addListing,
    approveListing,
    createListing,
    listItemsWithSource,
    listingProduct,
    listListings,
    listMine,
    listPending,
    readListingForReview,
    removeListingAsStaff,
    removeOwnListing,
    updateListing,
} from "../../../delivery/cloud/listings.ts";
import type { CloudOperation } from "../../../delivery/cloud/member.rules.ts";
import {
    createEmptyItem,
    itemHistory,
    listCloudProducts,
    withCloudScope,
} from "../../../delivery/cloud/member.ts";
import { createShare, importShare, revokeShare } from "../../../delivery/cloud/shares.ts";
import { asStaff, done, mapOk, served, type WebRpcContext } from "./web-shared.ts";

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
        scoped(ctx, { session, productId, operation: "list" }, listItemsWithSource),
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
    "cloud.listings.list": async (ctx, input, { session }) =>
        served(
            await listListings(ctx.auth.db, session, {
                catalog: ctx.catalog,
                productId: input.productId,
                owner: input.owner,
                kind: input.kind,
                text: input.text,
                cursor: input.cursor,
            }),
        ),
    "cloud.listings.mine": (ctx, { productId }, { session }) =>
        scoped(ctx, { session, productId, operation: "list" }, listMine),
    "cloud.listings.create": (ctx, { productId, itemId, summary }, { session }) =>
        scoped(ctx, { session, productId, operation: "share" }, (tx, scope) =>
            createListing(tx, scope, { itemId, summary }),
        ),
    "cloud.listings.update": async (ctx, { listingId, summary }, { session }) => {
        const productId = await listingProduct(ctx.auth.db, session, listingId);
        if (!productId.ok) return served(err(productId.error));
        return scoped(
            ctx,
            { session, productId: productId.value, operation: "share" },
            async (tx, scope) =>
                mapOk(await updateListing(tx, scope, { listingId, summary }), () => ({})),
        );
    },
    "cloud.listings.remove": async (ctx, { listingId }, { session }) => {
        const productId = await listingProduct(ctx.auth.db, session, listingId);
        if (!productId.ok) return served(err(productId.error));
        return scoped(
            ctx,
            { session, productId: productId.value, operation: "revoke" },
            async (tx, scope) => mapOk(await removeOwnListing(tx, scope, listingId), () => ({})),
        );
    },
    "cloud.listings.add": async (ctx, { listingId }, { session }) => {
        const productId = await listingProduct(ctx.auth.db, session, listingId);
        if (!productId.ok) return served(err(productId.error));
        return append(
            ctx,
            { session, productId: productId.value, operation: "import" },
            (tx, scope, limits) => addListing(tx, scope, { listingId, limits }),
        );
    },
    "admin.cloud.listings.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listPending(ctx.auth.db, { caller, cursor: input.cursor })),
    "admin.cloud.listings.get": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readListingForReview(ctx.auth.db, { caller, listingId: input.listingId }),
        ),
    "admin.cloud.listings.approve": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(
                await approveListing(ctx.auth.db, {
                    caller,
                    listingId: input.listingId,
                    revision: input.revision,
                }),
            ),
        ),
    "admin.cloud.listings.remove": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await removeListingAsStaff(ctx.auth.db, { caller, listingId: input.listingId })),
        ),
} satisfies Handlers<WebRpcContext, typeof cloudContract>;
