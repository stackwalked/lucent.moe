import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok } from "@lucent/core/result";
import { type AccountId, type BearerToken, ProductId } from "@lucent/core/scalars";
import { Channels, type SetPreference, type SetSubscription } from "@lucent/rpc/web/preferences";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { filterListedProducts } from "../products/visibility.ts";
import { withMember, written } from "./account.ts";
import { PRODUCT_DEFAULTS, SECURITY_CHANNELS } from "./deliveries.rules.ts";

export function findProductPreference(tx: Tx, accountId: AccountId) {
    return queryOne(
        tx,
        Channels,
        sql`select inbox, mail from notification_preference where account_id = ${accountId} and kind = 'product_status'`,
    );
}

export function listPreferences(db: Db, token: BearerToken, catalog: ProductCatalog) {
    return withMember(db, token, async (tx, id) => {
        const product = await findProductPreference(tx, id);
        if (!product.ok) return product;
        const rows = await queryAll(
            tx,
            z.object({ product_id: ProductId }),
            sql`select product_id from product_subscription where account_id = ${id} order by product_id`,
        );
        if (!rows.ok) return rows;
        const listed = await filterListedProducts(
            tx,
            { accountId: id, catalog },
            rows.value.map((r) => r.product_id),
        );
        if (!listed.ok) return listed;
        return ok({
            security: SECURITY_CHANNELS,
            product_status: product.value ?? PRODUCT_DEFAULTS,
            subscriptions: listed.value,
        });
    });
}

export function setPreference(db: Db, token: BearerToken, choice: z.output<typeof SetPreference>) {
    return withMember(db, token, async (tx, id) =>
        written(
            await execute(
                tx,
                sql`insert into notification_preference (account_id, kind, inbox, mail)
            values (${id}, ${choice.kind}, ${choice.inbox}, ${choice.mail})
            on conflict (account_id, kind) do update set inbox = excluded.inbox, mail = excluded.mail`,
            ),
        ),
    );
}

export function setSubscription(
    db: Db,
    token: BearerToken,
    choice: z.output<typeof SetSubscription> & { readonly catalog: ProductCatalog },
) {
    return withMember(db, token, async (tx, accountId) => {
        if (choice.following) {
            // Do the same visibility reads for every submitted id. A guessed seed and an
            // unknown id must not be distinguishable by an early catalog miss.
            const listed = await filterListedProducts(tx, { accountId, catalog: choice.catalog }, [
                ...choice.catalog.keys(),
            ]);
            if (!listed.ok) return listed;
            if (!listed.value.includes(choice.productId)) return err({ code: "NOT_FOUND" });
        }
        return written(
            await execute(
                tx,
                choice.following
                    ? sql`insert into product_subscription (account_id, product_id) values (${accountId}, ${choice.productId})
                  on conflict do nothing`
                    : sql`delete from product_subscription where account_id = ${accountId} and product_id = ${choice.productId}`,
            ),
        );
    });
}
