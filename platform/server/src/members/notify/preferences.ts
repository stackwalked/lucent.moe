import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { type AccountId, type BearerToken, ProductId } from "@lucent/core/scalars";
import { Channels, type SetPreference, type SetSubscription } from "@lucent/rpc/web/preferences";
import { z } from "zod";
import { type Db, type DbFailure, execute, queryAll, sql, type Tx } from "../../base/db/pool.ts";
import { filterListedProducts } from "../../delivery/products/visibility.ts";
import { withMember, written } from "./account.ts";
import {
    PRODUCT_DEFAULTS,
    SECURITY_CHANNELS,
    type StoredPreferences,
    TICKET_REPLY_DEFAULTS,
} from "./deliveries.rules.ts";

export async function findPreferences(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<StoredPreferences, DbFailure>> {
    const rows = await queryAll(
        tx,
        Channels.extend({ kind: z.enum(["product_status", "security", "ticket_reply"]) }),
        sql`select kind, inbox, discord from notification_preference
            where account_id = ${accountId}`,
    );
    if (!rows.ok) return rows;
    const channelsOf = (kind: "product_status" | "ticket_reply") => {
        const row = rows.value.find((r) => r.kind === kind);
        return row === undefined ? null : { inbox: row.inbox, discord: row.discord };
    };
    return ok({
        productStatus: channelsOf("product_status"),
        ticketReply: channelsOf("ticket_reply"),
        securityDiscord: rows.value.some((row) => row.kind === "security" && row.discord),
    });
}

export function listPreferences(db: Db, token: BearerToken, catalog: ProductCatalog) {
    return withMember(db, token, async (tx, id) => {
        const stored = await findPreferences(tx, id);
        if (!stored.ok) return stored;
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
            security: { ...SECURITY_CHANNELS, discord: stored.value.securityDiscord },
            product_status: stored.value.productStatus ?? PRODUCT_DEFAULTS,
            ticket_reply: {
                ...(stored.value.ticketReply ?? TICKET_REPLY_DEFAULTS),
                discord: false,
            },
            subscriptions: listed.value,
        });
    });
}

// A security row keeps inbox on: only its Discord choice is the member's. A ticket
// reply row has no Discord channel: it stores false.
export function setPreference(db: Db, token: BearerToken, choice: z.output<typeof SetPreference>) {
    const channels =
        choice.kind === "security"
            ? { ...SECURITY_CHANNELS, discord: choice.discord }
            : choice.kind === "ticket_reply"
              ? { inbox: choice.inbox, discord: false }
              : choice;
    return withMember(db, token, async (tx, id) =>
        written(
            await execute(
                tx,
                sql`insert into notification_preference (account_id, kind, inbox, discord)
            values (${id}, ${choice.kind}, ${channels.inbox}, ${channels.discord ?? false})
            on conflict (account_id, kind) do update
            set inbox = excluded.inbox,
                discord = coalesce(${channels.discord ?? null}::boolean, notification_preference.discord)`,
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
