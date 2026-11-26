import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { authorize, type Caller, can } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readEffectiveProductAccess } from "../../identity/authority/entitlements.ts";
import { lockCallerWith, readStanding } from "../../identity/authority/standing.ts";
import { authorAvatar } from "../../members/community/avatars.ts";
import { notBlockedWith } from "../../members/community/blocks.ts";
import type { PostingRefusal } from "../../members/community/standing.rules.ts";
import { mayPostHere } from "../../members/community/standing.ts";
import type { CloudLimits } from "./items.rules.ts";
import {
    type CloudItem,
    type CloudScope,
    createLockedItem,
    ItemKind,
    lockCloudScope,
    readItem,
} from "./items.ts";
import {
    decideApproval,
    decideFirstPin,
    decideRepin,
    LISTING_PAGE_SIZE,
    listingName,
    type Pins,
} from "./listings.rules.ts";
import { withCloudMember } from "./member.ts";

type NotFound = { readonly code: "NOT_FOUND" };
const missing = () => err<NotFound>({ code: "NOT_FOUND" });

const PinRow = z.object({
    id: z.uuid(),
    itemId: z.string(),
    kind: ItemKind,
    state: z.enum(["pending", "listed", "removed"]),
    revision: z.int().positive().nullable(),
    pending: z.int().positive().nullable(),
});

function pinsOf(row: z.output<typeof PinRow>): Pins | null {
    return row.state === "removed"
        ? null
        : { state: row.state, revision: row.revision, pending: row.pending };
}

async function txClock(tx: Tx) {
    const now = await queryOne(tx, z.object({ now: EpochMs }), sql`select now() as now`);
    if (!now.ok) return now;
    return now.value === null ? missing() : ok(now.value.now);
}

// The product a listing belongs to, read before the caller's scope is locked: a listing never
// changes product, and what the scoped work then does is decided again under lock.
export function listingProduct(db: Db, token: BearerToken, listingId: string) {
    return withCloudMember(db, token, async (tx) => {
        const found = await queryOne(
            tx,
            z.object({ productId: z.string() }),
            sql`select product_id as "productId" from cloud_listing where id = ${listingId}::uuid`,
        );
        if (!found.ok) return found;
        return found.value === null ? missing() : ok(ProductId.parse(found.value.productId));
    });
}

// Locks after cloud_scope (and cloud_share, which listing writes never take): the listing row.
function lockOwn(tx: Tx, scope: CloudScope, listingId: string) {
    return queryOne(
        tx,
        PinRow,
        sql`select id, item_id::text as "itemId", kind, state, revision, pending_revision as pending
            from cloud_listing
            where id = ${listingId}::uuid and owner_id = ${scope.accountId}
              and product_id = ${scope.productId}
            for update`,
    );
}

export async function createListing(
    tx: Tx,
    scope: CloudScope,
    params: { readonly itemId: string; readonly summary: string },
) {
    const locked = await lockCloudScope(tx, scope);
    if (!locked.ok) return locked;
    const now = await txClock(tx);
    if (!now.ok) return now;
    const may = await mayPostHere(tx, {
        accountId: scope.accountId,
        surface: "listing",
        productId: scope.productId,
        txNow: now.value,
    });
    if (!may.ok) return may;
    const head = await readItem(tx, { ...scope, itemId: params.itemId });
    if (!head.ok) return head;
    const kind = await queryOne(
        tx,
        z.object({ kind: ItemKind }),
        sql`select kind from cloud_item
            where account_id = ${scope.accountId} and product_id = ${scope.productId}
              and item_id = ${params.itemId}`,
    );
    if (!kind.ok) return kind;
    if (kind.value === null) return missing();
    const live = await queryOne(
        tx,
        z.object({ id: z.uuid() }),
        sql`select id from cloud_listing
            where owner_id = ${scope.accountId} and product_id = ${scope.productId}
              and item_id = ${params.itemId} and state <> 'removed'`,
    );
    if (!live.ok) return live;
    if (live.value !== null) return err({ code: "ALREADY_LISTED" as const });
    const pins = decideFirstPin({ kind: kind.value.kind, head: head.value.revision });
    const inserted = await queryOne(
        tx,
        z.object({ listingId: z.uuid() }),
        sql`insert into cloud_listing (owner_id, product_id, kind, item_id, revision,
                                       pending_revision, name, summary, state, listed_at)
            values (${scope.accountId}, ${scope.productId}, ${kind.value.kind}, ${params.itemId},
                    ${pins.revision}, ${pins.pending}, ${listingName(head.value.name)},
                    ${params.summary}, ${pins.state},
                    ${pins.state === "listed" ? sql`now()` : sql`null`})
            returning id as "listingId"`,
    );
    if (!inserted.ok) return inserted;
    return inserted.value === null ? missing() : ok(inserted.value);
}

export async function updateListing(
    tx: Tx,
    scope: CloudScope,
    params: { readonly listingId: string; readonly summary: string | undefined },
): Promise<Result<undefined, NotFound | PostingRefusal | DbFailure>> {
    const locked = await lockCloudScope(tx, scope);
    if (!locked.ok) return locked;
    const now = await txClock(tx);
    if (!now.ok) return now;
    const may = await mayPostHere(tx, {
        accountId: scope.accountId,
        surface: "listing",
        productId: scope.productId,
        txNow: now.value,
    });
    if (!may.ok) return may;
    const row = await lockOwn(tx, scope, params.listingId);
    if (!row.ok) return row;
    const current = row.value === null ? null : pinsOf(row.value);
    if (row.value === null || current === null) return missing();
    const head = await readItem(tx, { ...scope, itemId: row.value.itemId });
    if (!head.ok) return head;
    const pins = decideRepin({ kind: row.value.kind, current, head: head.value.revision });
    // The visible name and the moment move only when what others see does.
    const visibleChanges = pins.revision !== current.revision;
    const updated = await execute(
        tx,
        sql`update cloud_listing set
                revision = ${pins.revision}, pending_revision = ${pins.pending}, state = ${pins.state},
                name = ${visibleChanges || pins.state === "pending" ? listingName(head.value.name) : sql`name`},
                summary = ${params.summary ?? sql`summary`},
                listed_at = ${pins.state === "listed" ? sql`coalesce(listed_at, now())` : sql`listed_at`},
                updated_at = ${visibleChanges ? sql`now()` : sql`updated_at`}
            where id = ${params.listingId}::uuid`,
    );
    if (!updated.ok) return updated;
    return ok(undefined);
}

export async function removeOwnListing(
    tx: Tx,
    scope: CloudScope,
    listingId: string,
): Promise<Result<undefined, NotFound | DbFailure>> {
    const locked = await lockCloudScope(tx, scope);
    if (!locked.ok) return locked;
    const row = await lockOwn(tx, scope, listingId);
    if (!row.ok) return row;
    if (row.value === null) return missing();
    if (row.value.state === "removed") return ok(undefined);
    const removed = await execute(tx, sql`${takeDown(listingId, scope.accountId)}`);
    if (!removed.ok) return removed;
    return ok(undefined);
}

// A listing taken down keeps its row and pins nothing.
export function takeDown(listingId: string, by: AccountId): SqlFragment {
    return sql`update cloud_listing set state = 'removed', revision = null, pending_revision = null,
            removed_at = now(), removed_by = ${by}, updated_at = now()
        where id = ${listingId}::uuid and state <> 'removed'`;
}

export function listMine(tx: Tx, scope: CloudScope) {
    return queryAll(
        tx,
        z.object({
            id: z.uuid(),
            itemId: z.string(),
            name: z.string(),
            kind: ItemKind,
            summary: z.string(),
            state: z.enum(["pending", "listed"]),
            pending: z.boolean(),
            updatedAt: EpochMs,
        }),
        sql`select id, item_id::text as "itemId", name, kind, summary, state,
                   pending_revision is not null as pending, updated_at as "updatedAt"
            from cloud_listing
            where owner_id = ${scope.accountId} and product_id = ${scope.productId}
              and state <> 'removed'
            order by updated_at desc, id desc`,
    );
}

// The viewer's items, each with where it was copied from, if it was.
export function listItemsWithSource(tx: Tx, scope: CloudScope) {
    return queryAll(
        tx,
        z.object({
            itemId: z.string(),
            kind: ItemKind,
            revision: z.int().positive(),
            name: z.string(),
            source: z.object({ listingId: z.string(), owner: z.string().nullable() }).nullable(),
        }),
        sql`select distinct on (i.item_id) i.item_id::text as "itemId", i.kind, v.revision, v.name,
                   case when i.source_listing_id is null then null
                        else json_build_object('listingId', i.source_listing_id::text,
                                               'owner', (select a.username from cloud_listing l
                                                         join account a on a.id = l.owner_id
                                                         where l.id = i.source_listing_id))
                   end as source
            from cloud_item i join cloud_version v using (account_id, product_id, item_id)
            where i.account_id = ${scope.accountId} and i.product_id = ${scope.productId}
            order by i.item_id, v.revision desc`,
    );
}

const ListedRow = z.object({
    id: z.uuid(),
    productId: ProductId,
    name: z.string(),
    kind: ItemKind,
    summary: z.string(),
    username: z.string().nullable(),
    avatar: z.string().nullable(),
    updatedAt: EpochMs,
    added: z.boolean(),
});

function likeEscape(text: string): string {
    return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// What a member may browse: listings of products they hold an active entitlement to, `listed`
// only, newest update first, leaving out owners they block or are blocked by, tombstones and
// suspended owners. With `owner`, that account's listings only, and only while its profile is
// one the viewer may open.
export function listListings(
    db: Db,
    token: BearerToken,
    params: {
        readonly catalog: ProductCatalog;
        readonly productId: ProductId | undefined;
        readonly owner: string | undefined;
        readonly kind: z.output<typeof ItemKind> | undefined;
        readonly text: string | undefined;
        readonly cursor: string | undefined;
    },
) {
    return withCloudMember(db, token, async (tx, accountId) => {
        const entitled: ProductId[] = [];
        for (const product of params.catalog.values()) {
            if (params.productId !== undefined && product.id !== params.productId) continue;
            const access = await readEffectiveProductAccess(tx, {
                accountId,
                product,
                at: "transaction",
            });
            if (!access.ok) return access;
            if (access.value.isEntitled) entitled.push(product.id);
        }
        if (params.productId !== undefined && entitled.length === 0) return missing();
        if (entitled.length === 0) return ok({ items: [], nextCursor: null });
        const after =
            params.cursor === undefined
                ? sql``
                : sql`and (l.updated_at, l.id) < (select c.updated_at, c.id from cloud_listing c
                                                  where c.id = ${params.cursor}::uuid and c.state = 'listed')`;
        const owner =
            params.owner === undefined
                ? sql``
                : sql`and a.username = ${params.owner.toLowerCase()}
                      and (a.id = ${accountId} or coalesce(p.visibility, 'members') = 'members')`;
        const kind = params.kind === undefined ? sql`` : sql`and l.kind = ${params.kind}`;
        const text =
            params.text === undefined
                ? sql``
                : sql`and (l.name ilike ${`%${likeEscape(params.text)}%`} escape '\\'
                           or l.summary ilike ${`%${likeEscape(params.text)}%`} escape '\\')`;
        const rows = await queryAll(
            tx,
            ListedRow,
            sql`select l.id, l.product_id as "productId", l.name, l.kind, l.summary, a.username,
                       ${authorAvatar(accountId, sql`l.owner_id`)} as avatar,
                       l.updated_at as "updatedAt",
                       exists (select 1 from cloud_item c
                               where c.account_id = ${accountId} and c.product_id = l.product_id
                                 and c.source_listing_id = l.id) as added
                from cloud_listing l
                join account a on a.id = l.owner_id
                left join profile p on p.account_id = l.owner_id
                where l.state = 'listed' and l.product_id = any(${entitled}::text[])
                  and a.username is not null and a.status = 'active'
                  and ${notBlockedWith(accountId, sql`l.owner_id`)}
                  ${owner} ${kind} ${text} ${after}
                order by l.updated_at desc, l.id desc limit ${LISTING_PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value
            .slice(0, LISTING_PAGE_SIZE)
            .map(({ username, avatar, ...row }) => ({
                ...row,
                owner: { username, avatar },
            }));
        return ok({
            items,
            nextCursor: rows.value.length > LISTING_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        });
    });
}

// A copy goes into the viewer's cloud by the path a share import takes: same limits, same
// refusals. Adding the same listing twice is refused; a copy never follows the listing.
export async function addListing(
    tx: Tx,
    scope: CloudScope,
    params: { readonly listingId: string; readonly limits: CloudLimits },
) {
    const locked = await lockCloudScope(tx, scope);
    if (!locked.ok) return locked;
    const snapshot = await queryOne(
        tx,
        z.object({ kind: ItemKind, name: z.string(), bytes: z.instanceof(Uint8Array) }),
        sql`select l.kind, v.name, v.bytes
            from cloud_listing l
            join cloud_version v on (v.account_id, v.product_id, v.item_id, v.revision) =
                                    (l.owner_id, l.product_id, l.item_id, l.revision)
            join account a on a.id = l.owner_id
            where l.id = ${params.listingId}::uuid and l.state = 'listed'
              and l.product_id = ${scope.productId}
              and a.username is not null and a.status = 'active'
              and ${notBlockedWith(scope.accountId, sql`l.owner_id`)}
            for share of l`,
    );
    if (!snapshot.ok) return snapshot;
    if (snapshot.value === null) return missing();
    const held = await queryOne(
        tx,
        z.object({ held: z.boolean() }),
        sql`select exists (select 1 from cloud_item
                where account_id = ${scope.accountId} and product_id = ${scope.productId}
                  and source_listing_id = ${params.listingId}::uuid) as held`,
    );
    if (!held.ok) return held;
    if (held.value?.held === true) return err({ code: "ALREADY_ADDED" as const });
    return createLockedItem(locked.value, {
        limits: params.limits,
        sourceListingId: params.listingId,
        ...snapshot.value,
    });
}

// Staff: what waits for approval, oldest first (a first-time script, or a listed script's update).
export function listPending(
    db: Db,
    params: { readonly caller: Caller; readonly cursor: string | null },
) {
    return withTx(db, async (tx, txNow) => {
        const standing = await readStanding(tx, params.caller.accountId, txNow);
        if (!standing.ok) return standing;
        if (
            standing.value === null ||
            !can({ ...standing.value, stepUpAt: params.caller.stepUpAt }, "moderation:remove")
        ) {
            return err({ code: "FORBIDDEN" as const });
        }
        const after =
            params.cursor === null
                ? sql``
                : sql`and (l.updated_at, l.id) > (select c.updated_at, c.id from cloud_listing c
                                                  where c.id = ${params.cursor}::uuid)`;
        const rows = await queryAll(
            tx,
            z.object({
                id: z.uuid(),
                productId: ProductId,
                kind: ItemKind,
                name: z.string(),
                summary: z.string(),
                accountId: AccountId,
                username: z.string().nullable(),
                first: z.boolean(),
                updatedAt: EpochMs,
            }),
            sql`select l.id, l.product_id as "productId", l.kind, pv.name, l.summary,
                       l.owner_id as "accountId", a.username, l.state = 'pending' as first,
                       l.updated_at as "updatedAt"
                from cloud_listing l
                join account a on a.id = l.owner_id
                join cloud_version pv on (pv.account_id, pv.product_id, pv.item_id, pv.revision) =
                                         (l.owner_id, l.product_id, l.item_id, l.pending_revision)
                where l.state <> 'removed' and l.pending_revision is not null ${after}
                order by l.updated_at, l.id limit ${LISTING_PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const items = rows.value
            .slice(0, LISTING_PAGE_SIZE)
            .map(({ accountId, username, ...row }) => ({
                ...row,
                owner: { accountId, username },
            }));
        return ok({
            items,
            nextCursor: rows.value.length > LISTING_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        });
    });
}

const StaffRow = z.object({
    ownerId: z.string(),
    productId: z.string(),
    kind: ItemKind,
    state: z.enum(["pending", "listed", "removed"]),
    revision: z.int().positive().nullable(),
    pending: z.int().positive().nullable(),
    pendingName: z.string().nullable(),
});

export async function approveListing(
    db: Db,
    params: { readonly caller: Caller; readonly listingId: string },
) {
    return await withTx(db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "moderation:remove",
        });
        if (!authz.ok) return authz;
        const row = await queryOne(
            tx,
            StaffRow,
            sql`select l.owner_id as "ownerId", l.product_id as "productId", l.kind, l.state,
                       l.revision, l.pending_revision as pending,
                       (select v.name from cloud_version v
                        where (v.account_id, v.product_id, v.item_id, v.revision) =
                              (l.owner_id, l.product_id, l.item_id, l.pending_revision)) as "pendingName"
                from cloud_listing l where l.id = ${params.listingId}::uuid for update`,
        );
        if (!row.ok) return row;
        if (row.value === null || row.value.state === "removed") return missing();
        const next = decideApproval({
            state: row.value.state,
            revision: row.value.revision,
            pending: row.value.pending,
        });
        if (!next.ok) return next;
        const updated = await execute(
            tx,
            sql`update cloud_listing set state = 'listed', revision = ${next.value.revision},
                    pending_revision = null, name = ${listingName(row.value.pendingName ?? "")},
                    listed_at = coalesce(listed_at, now()), updated_at = now()
                where id = ${params.listingId}::uuid`,
        );
        if (!updated.ok) return updated;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "cloud.listing.approve",
            target: {
                accountId: row.value.ownerId,
                listingId: params.listingId,
                productId: row.value.productId,
                kind: row.value.kind,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok(undefined);
    });
}

export async function removeListingAsStaff(
    db: Db,
    params: { readonly caller: Caller; readonly listingId: string },
) {
    return await withTx(db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "moderation:remove",
        });
        if (!authz.ok) return authz;
        const row = await queryOne(
            tx,
            z.object({ ownerId: z.string(), productId: z.string(), state: z.string() }),
            sql`select owner_id as "ownerId", product_id as "productId", state
                from cloud_listing where id = ${params.listingId}::uuid for update`,
        );
        if (!row.ok) return row;
        if (row.value === null || row.value.state === "removed") return missing();
        const removed = await execute(tx, takeDown(params.listingId, params.caller.accountId));
        if (!removed.ok) return removed;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "cloud.listing.remove",
            target: {
                accountId: row.value.ownerId,
                listingId: params.listingId,
                productId: row.value.productId,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok(undefined);
    });
}

export type { CloudItem };
