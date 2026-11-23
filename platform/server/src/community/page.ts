import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import type { AccountId, ProductId } from "@lucent/core/scalars";
import type { Tx } from "../db/pool.ts";
import { isListedForMember } from "../products/visibility.ts";

export const PAGE_SIZE = 25;

// Lists page by (created_at, id) with the last row's id as the cursor; the next page's query
// resolves it against its own table, so a cursor for a row that was never there ends the list.
export function pageOf<Row extends { readonly id: string }>(rows: readonly Row[]) {
    const items = rows.slice(0, PAGE_SIZE);
    return {
        items,
        nextCursor: rows.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
    };
}

export type NotFound = { readonly code: "NOT_FOUND" };

// Product-scoped content shows only to members who may see the product (platform's listing
// rule); anyone else gets the answer a missing thing gets.
export async function requireListed(
    tx: Tx,
    params: {
        readonly accountId: AccountId;
        readonly catalog: ProductCatalog;
        readonly productId: ProductId;
    },
) {
    const listed = await isListedForMember(
        tx,
        { accountId: params.accountId, catalog: params.catalog },
        params.productId,
    );
    if (!listed.ok) return listed;
    return listed.value ? ok(null) : err<NotFound>({ code: "NOT_FOUND" });
}
