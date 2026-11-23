import type { ProductCatalog } from "@lucent/catalog/catalog";
import { ok } from "@lucent/core/result";
import { type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, sql } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import { filterListedProducts } from "../products/visibility.ts";
import { notBlockedWith } from "./blocks.ts";

const LIMIT = 20;

// Letters and digits only, each as a prefix: what is typed can never be tsquery syntax.
function prefixQuery(q: string): string | null {
    const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return tokens === null ? null : tokens.map((token) => `${token}:*`).join(" & ");
}

const GuideRow = z.object({
    id: z.uuid(),
    productId: ProductId,
    title: z.string(),
    username: z.string().nullable(),
    updatedAt: EpochMs,
});

export function searchCommunity(
    db: Db,
    token: BearerToken,
    params: { readonly catalog: ProductCatalog; readonly q: string },
) {
    return withMember(db, token, async (tx, accountId) => {
        const listed = await filterListedProducts(tx, { accountId, catalog: params.catalog }, [
            ...params.catalog.keys(),
        ]);
        if (!listed.ok) return listed;
        const guides = await queryAll(
            tx,
            GuideRow,
            sql`select g.id, g.product_id as "productId", g.title, a.username, g.updated_at as "updatedAt"
                from guide g join account a on a.id = g.author_id,
                     websearch_to_tsquery('english', ${params.q}) as query
                where g.search @@ query and g.removed_at is null
                  and g.product_id = any(${listed.value}::text[])
                  and ${notBlockedWith(accountId, sql`g.author_id`)}
                order by ts_rank(g.search, query) desc, g.id limit ${LIMIT}`,
        );
        if (!guides.ok) return guides;
        const prefix = prefixQuery(params.q);
        const accounts =
            prefix === null
                ? ok([])
                : await queryAll(
                      tx,
                      z.object({ username: z.string() }),
                      sql`select a.username from account a left join profile p on p.account_id = a.id
                          where to_tsvector('simple', coalesce(a.username, '')) @@ to_tsquery('simple', ${prefix})
                            and a.username is not null
                            and (a.id = ${accountId} or coalesce(p.visibility, 'members') = 'members')
                            and ${notBlockedWith(accountId, sql`a.id`)}
                          order by a.username limit ${LIMIT}`,
                  );
        if (!accounts.ok) return accounts;
        return ok({
            guides: guides.value.map(({ username, ...row }) => ({ ...row, author: { username } })),
            accounts: accounts.value,
        });
    });
}
