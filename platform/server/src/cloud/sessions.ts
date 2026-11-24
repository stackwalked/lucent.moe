import { err, ok } from "@lucent/core/result";
import { type AccountId, type EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { lockActiveAccount } from "../authority/accounts.ts";
import { queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import type { CloudLimits } from "./items.rules.ts";
import {
    type CloudScope,
    changeItem,
    createLockedItem,
    ItemKind,
    lockCloudScope,
    readItem,
} from "./items.ts";

// A running session reaches its own account's items for its own product: both come from the
// session row, found by the id the frame names and the account the loader's token holds, never
// from the request. The transport has already decided the session's standing (lease, slot,
// device) under the same account lock; this only refuses a session that has ended or an account
// that may no longer act.
export type SessionCaller = {
    readonly accountId: AccountId;
    readonly sessionId: Uint8Array;
    readonly txNow: EpochMs;
};

const SessionProduct = z.object({ productId: ProductId });

async function lockSessionScope(tx: Tx, caller: SessionCaller) {
    const active = await lockActiveAccount(tx, caller.accountId, caller.txNow);
    if (!active.ok) return active;
    // Shared: the data route already holds the row for update, and ending a session waits on it.
    const session = await queryOne(
        tx,
        SessionProduct,
        sql`select product_id as "productId" from runtime_session
        where id = ${caller.sessionId} and account_id = ${caller.accountId} and ended_at is null
        for share`,
    );
    if (!session.ok) return session;
    if (session.value === null) return err({ code: "NOT_FOUND" });
    const scope: CloudScope = { accountId: caller.accountId, productId: session.value.productId };
    return ok(scope);
}

const Listed = z.object({
    itemId: z.string(),
    kind: ItemKind,
    revision: z.int().positive(),
    name: z.string(),
    size: z.int(),
});

// Each item's head, with the size a module needs to plan its fetches.
export async function listSessionItems(tx: Tx, caller: SessionCaller) {
    const scope = await lockSessionScope(tx, caller);
    if (!scope.ok) return scope;
    return queryAll(
        tx,
        Listed,
        sql`select distinct on (item_id) item_id::text as "itemId", kind, revision, name,
            octet_length(bytes) as size
        from cloud_item join cloud_version using (account_id, product_id, item_id)
        where account_id = ${scope.value.accountId} and product_id = ${scope.value.productId}
        order by item_id, revision desc`,
    );
}

// The head, or the retained version at `revision`.
export async function readSessionItem(
    tx: Tx,
    params: SessionCaller & { readonly itemId: string; readonly revision?: number },
) {
    const scope = await lockSessionScope(tx, params);
    if (!scope.ok) return scope;
    return readItem(tx, { ...scope.value, itemId: params.itemId }, params.revision);
}

export type SessionWrite =
    | {
          readonly type: "create";
          readonly kind: z.output<typeof ItemKind>;
          readonly name: string;
          readonly bytes: Uint8Array;
      }
    | {
          readonly type: "replace";
          readonly itemId: string;
          readonly base: number;
          readonly bytes: Uint8Array;
      };

// Last write wins by server revision: a replace whose base is no longer the head still becomes
// the head, at the next revision, and says so with `conflict`; the head it displaced stays in
// history at its own revision. The caps and the version window are the web writers' own,
// decided by the same rule.
export async function writeSessionItem(
    tx: Tx,
    params: SessionCaller & { readonly write: SessionWrite; readonly limits: CloudLimits },
) {
    const scope = await lockSessionScope(tx, params);
    if (!scope.ok) return scope;
    const { write, limits } = params;
    if (write.type === "replace") {
        const changed = await changeItem(tx, {
            ...scope.value,
            itemId: write.itemId,
            base: write.base,
            limits,
            change: { type: "replace", bytes: write.bytes },
        });
        if (!changed.ok) return changed;
        return ok({ itemId: write.itemId, ...changed.value });
    }
    const locked = await lockCloudScope(tx, scope.value);
    if (!locked.ok) return locked;
    const { kind, name, bytes } = write;
    const created = await createLockedItem(locked.value, { kind, name, bytes, limits });
    if (!created.ok) return created;
    return ok({ ...created.value, conflict: false });
}
