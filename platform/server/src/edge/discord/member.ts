import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs, type ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    type Queryable,
    queryOne,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readMemberProducts } from "../../delivery/products/products.ts";
import { lockCallerWith } from "../../identity/authority/standing.ts";
import { readAccountDevices } from "../../identity/devices/devices.ts";
import { readOwnRestrictions } from "../../members/community/standing.ts";
import { openTicketFor } from "../../members/support/tickets.ts";
import { readPublicStatuses } from "./feeds.ts";

// What a Discord user may learn of the account linked to them, and nothing about any other: an
// unlinked user hears "unlinked" whether or not an account exists, and every answer below is
// built from the reads the site's own pages use, so /me says what the site says.

export type LinkedAccount =
    | { readonly standing: "unlinked" }
    | { readonly standing: "suspended" | "locked"; readonly accountId: AccountId }
    | { readonly standing: "active"; readonly accountId: AccountId };

const LinkedRow = z.object({
    account_id: AccountId,
    status: z.enum(["active", "suspended"]),
    is_locked: z.boolean(),
});

function standingOf(row: z.output<typeof LinkedRow> | null): LinkedAccount {
    if (row === null) return { standing: "unlinked" };
    if (row.status === "suspended") return { standing: "suspended", accountId: row.account_id };
    if (row.is_locked) return { standing: "locked", accountId: row.account_id };
    return { standing: "active", accountId: row.account_id };
}

async function findLinkedAccount(
    q: Queryable,
    userId: string,
): Promise<Result<LinkedAccount, DbFailure>> {
    const row = await queryOne(
        q,
        LinkedRow,
        sql`select a.id as account_id, a.status, a.is_locked
            from connector_discord_link l join account a on a.id = l.account_id
            where l.discord_user_id = ${userId}`,
    );
    return row.ok ? ok(standingOf(row.value)) : row;
}

// The earliest end among entitlements running now; null when none ends.
async function readNextExpiry(q: Queryable, accountId: AccountId) {
    const row = await queryOne(
        q,
        z.object({ next: EpochMs.nullable() }),
        sql`select min(valid_until) as next from entitlement
            where account_id = ${accountId} and status = 'active'
              and valid_from <= now() and valid_until > now()`,
    );
    return row.ok ? ok(row.value?.next ?? null) : row;
}

export async function readMe(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly userId: string },
) {
    return await withTx(db, async (tx, txNow) => {
        const linked = await findLinkedAccount(tx, params.userId);
        if (!linked.ok) return linked;
        if (linked.value.standing !== "active") return ok({ standing: linked.value.standing });
        const { accountId } = linked.value;
        const products = await readMemberProducts(tx, { catalog: params.catalog, accountId });
        if (!products.ok) return products;
        const devices = await readAccountDevices(tx, { accountId, txNow });
        if (!devices.ok) return devices;
        const nextExpiry = await readNextExpiry(tx, accountId);
        if (!nextExpiry.ok) return nextExpiry;
        const restrictions = await readOwnRestrictions(tx, accountId);
        if (!restrictions.ok) return restrictions;
        return ok({
            standing: "active" as const,
            products: products.value.map((product) => ({
                productId: product.productId,
                name: product.name,
                state: product.state,
                features: product.features,
                channels: product.channels,
            })),
            devices: { count: devices.value.devices.length, limit: devices.value.limit },
            nextExpiry: nextExpiry.value,
            restrictions: restrictions.value.restrictions.map((restriction) => ({
                kind: restriction.kind,
                product:
                    restriction.productId === null
                        ? null
                        : (params.catalog.get(restriction.productId)?.name ??
                          restriction.productId),
                endsAt: restriction.endsAt,
            })),
        });
    });
}

export async function readStatus(db: Db, catalog: ProductCatalog) {
    return await withTx(db, async (tx) => {
        const statuses = await readPublicStatuses(tx, catalog);
        if (!statuses.ok) return statuses;
        return ok({ products: [...statuses.value.values()] });
    });
}

// The products /ticket's form offers: those listed for the account, as the site's form offers.
export async function readTicketProducts(
    db: Db,
    params: { readonly catalog: ProductCatalog; readonly userId: string },
) {
    return await withTx(db, async (tx) => {
        const linked = await findLinkedAccount(tx, params.userId);
        if (!linked.ok) return linked;
        if (linked.value.standing !== "active") return ok({ standing: linked.value.standing });
        const products = await readMemberProducts(tx, {
            catalog: params.catalog,
            accountId: linked.value.accountId,
        });
        if (!products.ok) return products;
        return ok({
            standing: "active" as const,
            products: products.value.map(({ productId, name }) => ({ id: productId, name })),
        });
    });
}

type TicketRefusal =
    | { readonly code: "NOT_LINKED" }
    | { readonly code: "ACCOUNT_UNAVAILABLE" }
    | { readonly code: "UNKNOWN_PRODUCT" }
    | { readonly code: "TICKET_LIMIT" };

// The account is locked as a member session's writer locks it, and read again under the lock:
// a suspension or an unlink a moment ago is honoured. Then the site's own writer and limits.
async function lockLinked(tx: Tx, userId: string, txNow: EpochMs) {
    const seen = await findLinkedAccount(tx, userId);
    if (!seen.ok || seen.value.standing === "unlinked") return seen;
    const locked = await lockCallerWith(tx, {
        caller: { accountId: seen.value.accountId, stepUpAt: null, client: null },
        targets: [],
        txNow,
    });
    if (!locked.ok) {
        const failure = locked.error;
        if (failure.code === "FORBIDDEN" || failure.code === "STEP_UP_REQUIRED") {
            return ok({ standing: "unlinked" as const });
        }
        return err(failure);
    }
    const now = await findLinkedAccount(tx, userId);
    // Relinked to another account between the two reads: that account is not the one locked.
    if (
        now.ok &&
        now.value.standing !== "unlinked" &&
        now.value.accountId !== seen.value.accountId
    ) {
        return ok({ standing: "unlinked" as const });
    }
    return now;
}

export async function openTicketFromDiscord(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly siteOrigin: string;
        readonly userId: string;
        readonly productId: ProductId | null;
        readonly subject: string;
        readonly body: string;
    },
): Promise<Result<{ readonly ticketId: string; readonly url: string }, TicketRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const linked = await lockLinked(tx, params.userId, txNow);
        if (!linked.ok) return linked;
        if (linked.value.standing === "unlinked") return err({ code: "NOT_LINKED" as const });
        if (linked.value.standing !== "active") {
            return err({ code: "ACCOUNT_UNAVAILABLE" as const });
        }
        const opened = await openTicketFor(tx, {
            accountId: linked.value.accountId,
            catalog: params.catalog,
            productId: params.productId,
            subject: params.subject,
            body: params.body,
        });
        if (!opened.ok) return opened;
        const { ticketId } = opened.value;
        return ok({ ticketId, url: `${params.siteOrigin}/tickets/${ticketId}` });
    });
}
