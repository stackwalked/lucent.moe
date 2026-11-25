import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import type { BearerToken } from "@lucent/core/scalars";
import { z } from "zod";
import { hashToken, issueToken } from "../auth/tokens.ts";
import { execute, type Queryable, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import type { CloudLimits } from "./items.rules.ts";
import {
    type CloudItem,
    type CloudScope,
    createLockedItem,
    ItemKind,
    lockCloudScope,
} from "./items.ts";
import { decideShare, MAX_SHARES_PER_ITEM } from "./shares.rules.ts";

const isShared = (item: CloudItem) =>
    sql`account_id = ${item.accountId} and product_id = ${item.productId} and item_id = ${item.itemId}`;

// Management survives the session that issued the bearer without ever returning it again.
export function listShares(q: Queryable, item: CloudItem) {
    return queryAll(
        q,
        z.object({ shareId: z.string(), revision: z.int().positive() }),
        sql`select share_id::text as "shareId", revision from cloud_share
        where account_id = ${item.accountId} and product_id = ${item.productId} and item_id = ${item.itemId}
        order by share_id`,
    );
}

const ShareGather = z.object({ head: z.int().positive().nullable(), shares: z.int() });

// Each share pins its snapshot out of the item's version window, so their count is capped.
export async function createShare(tx: Tx, item: CloudItem, rng: CryptoRng) {
    const locked = await lockCloudScope(tx, item);
    if (!locked.ok) return locked;
    const gathered = await queryOne(
        tx,
        ShareGather,
        sql`select (select max(revision) from cloud_version where ${isShared(item)}) as head,
            (select count(*) from cloud_share where ${isShared(item)})::integer as shares`,
    );
    if (!gathered.ok) return gathered;
    invariant(gathered.value !== null, "a select without from yields its row");
    const { head, shares } = gathered.value;
    if (head === null) return err({ code: "NOT_FOUND" });
    const allowed = decideShare({ shares, maxShares: MAX_SHARES_PER_ITEM });
    if (!allowed.ok) return allowed;
    const { token, hash } = await issueToken(rng);
    const share = await queryOne(
        tx,
        z.object({ shareId: z.string() }),
        sql`insert into cloud_share (account_id, product_id, item_id, revision, token_hash)
        values (${item.accountId}, ${item.productId}, ${item.itemId}, ${head}, ${hash})
        returning share_id::text as "shareId"`,
    );
    if (!share.ok) return share;
    invariant(share.value !== null, "a share insert returns its id");
    return ok({ ...share.value, token });
}

// Under the scope lock, so a share count gathered for a new link is still true when it is written.
export async function revokeShare(tx: Tx, scope: CloudScope, shareId: string) {
    const locked = await lockCloudScope(tx, scope);
    if (!locked.ok) return locked;
    const removed = await execute(
        tx,
        sql`delete from cloud_share where account_id = ${scope.accountId}
        and product_id = ${scope.productId} and share_id = ${shareId}`,
    );
    if (!removed.ok) return removed;
    return removed.value === 0 ? err({ code: "NOT_FOUND" }) : ok(undefined);
}

const Snapshot = z.object({ kind: ItemKind, name: z.string(), bytes: z.instanceof(Uint8Array) });

export async function importShare(
    tx: Tx,
    params: CloudScope & {
        readonly token: BearerToken;
        readonly limits: CloudLimits;
    },
) {
    const locked = await lockCloudScope(tx, params);
    if (!locked.ok) return locked;
    const hash = await hashToken(params.token);
    // The bearer identifies the source owner, never an importer-supplied account or item id.
    // A share lock makes revocation wait until this copy commits, or win before it starts.
    const snapshot = await queryOne(
        tx,
        Snapshot,
        sql`select kind, name, bytes
        from cloud_share s join cloud_version using (account_id, product_id, item_id, revision)
        join cloud_item using (account_id, product_id, item_id)
        where s.token_hash = ${hash} and s.product_id = ${params.productId} for share of s`,
    );
    if (!snapshot.ok) return snapshot;
    if (snapshot.value === null) return err({ code: "NOT_FOUND" });
    return createLockedItem(locked.value, { limits: params.limits, ...snapshot.value });
}
