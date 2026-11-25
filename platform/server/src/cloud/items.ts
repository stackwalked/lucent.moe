import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import type { AccountId, ProductId } from "@lucent/core/scalars";
import { ItemKind } from "@lucent/rpc/cloud-item";
import { z } from "zod";
import { execute, type Queryable, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { type AppendPlan, type CloudLimits, decideAppend } from "./items.rules.ts";

// The transport derives this from authenticated authority, never from an item's claimed owner.
export type CloudScope = { readonly accountId: AccountId; readonly productId: ProductId };
export type CloudItem = CloudScope & { readonly itemId: string };
export { ItemKind };

type Content = { readonly name: string; readonly bytes: Uint8Array };
const Metadata = z.object({
    itemId: z.string(),
    kind: ItemKind,
    revision: z.int().positive(),
    name: z.string(),
});
const Version = Metadata.extend({ bytes: z.instanceof(Uint8Array) });

const inScope = (s: CloudScope) => sql`account_id = ${s.accountId} and product_id = ${s.productId}`;
const isItem = (s: CloudItem) => sql`${inScope(s)} and item_id = ${s.itemId}`;
const metadata = sql`item_id::text as "itemId", kind, revision, name`;
const versions = sql`cloud_item join cloud_version using (account_id, product_id, item_id)`;
// What a version costs against the product's storage: its name is part of the snapshot.
const storedBytes = sql`octet_length(bytes)::bigint + octet_length(name)`;

export function listItems(q: Queryable, scope: CloudScope) {
    return queryAll(
        q,
        Metadata,
        sql`select distinct on (item_id) ${metadata} from ${versions}
        where ${inScope(scope)} order by item_id, revision desc`,
    );
}

export function listHistory(q: Queryable, item: CloudItem) {
    return queryAll(
        q,
        Metadata,
        sql`select ${metadata} from ${versions}
        where ${isItem(item)} order by revision desc`,
    );
}

export async function readItem(q: Queryable, item: CloudItem, revision?: number) {
    const version = await queryOne(
        q,
        Version,
        sql`select ${metadata}, bytes from ${versions}
        where ${isItem(item)} ${revision === undefined ? sql`` : sql`and revision = ${revision}`}
        order by revision desc limit 1`,
    );
    if (!version.ok) return version;
    return version.value === null ? err({ code: "NOT_FOUND" }) : ok(version.value);
}

// Every item writer takes this before gathering usage, a head or shares, including first-ever
// writers in an empty scope: the account (as every writer does first, platform/AGENTS.md), then
// the scope. Holding the account serializes the writer with a suspension; whether the account
// may act is the caller's decision under this same lock (the member session's lock for web,
// the session standing for a running session).
const scopeLock = Symbol("cloud.scopeLock");
export type LockedScope = CloudScope & { readonly [scopeLock]: Tx };

export async function lockCloudScope(tx: Tx, scope: CloudScope) {
    const account = await execute(
        tx,
        sql`select 1 from account where id = ${scope.accountId} for update`,
    );
    if (!account.ok) return account;
    if (account.value === 0) return err({ code: "NOT_FOUND" });
    const inserted = await execute(
        tx,
        sql`insert into cloud_scope (account_id, product_id)
        values (${scope.accountId}, ${scope.productId}) on conflict do nothing`,
    );
    if (!inserted.ok) return inserted;
    const locked = await execute(
        tx,
        sql`select 1 from cloud_scope where ${inScope(scope)} for update`,
    );
    if (!locked.ok) return locked;
    invariant(locked.value === 1, "cloud scope disappeared before lock");
    return ok({ accountId: scope.accountId, productId: scope.productId, [scopeLock]: tx });
}

export function txOf(scope: LockedScope): Tx {
    return scope[scopeLock];
}

const ItemShape = z.object({ head: z.int(), versions: z.int() });
const Droppable = z.object({ revision: z.int().positive(), storedBytes: z.coerce.number().int() });
const Usage = z.object({ items: z.int(), storedBytes: z.coerce.number().int() });

async function gatherAppend(scope: LockedScope, itemId: string | null) {
    const tx = txOf(scope);
    const usage = await queryOne(
        tx,
        Usage,
        sql`select count(distinct item_id)::integer as items,
            coalesce(sum(${storedBytes}), 0) as "storedBytes"
            from cloud_version where ${inScope(scope)}`,
    );
    if (!usage.ok) return usage;
    invariant(usage.value !== null, "cloud usage aggregate missing");
    if (itemId === null) return ok({ head: 0, versions: 0, droppable: null, usage: usage.value });
    const item = { ...scope, itemId };
    const shape = await queryOne(
        tx,
        ItemShape,
        sql`select coalesce(max(revision), 0)::integer as head, count(*)::integer as versions
            from cloud_version where ${isItem(item)}`,
    );
    if (!shape.ok) return shape;
    invariant(shape.value !== null, "cloud item aggregate missing");
    const droppable = await queryOne(
        tx,
        Droppable,
        sql`select revision, ${storedBytes} as "storedBytes" from cloud_version v
            where ${isItem(item)} and revision < ${shape.value.head}
            and not exists (select 1 from cloud_share s
                where (s.account_id, s.product_id, s.item_id, s.revision) =
                    (v.account_id, v.product_id, v.item_id, v.revision))
            order by revision limit 1`,
    );
    if (!droppable.ok) return droppable;
    return ok({ ...shape.value, droppable: droppable.value, usage: usage.value });
}

async function planAppend(
    scope: LockedScope,
    params: Content & {
        readonly itemId: string | null;
        readonly base: number;
        readonly limits: CloudLimits;
    },
) {
    const snapshot = await gatherAppend(scope, params.itemId);
    if (!snapshot.ok) return snapshot;
    return decideAppend({
        ...snapshot.value,
        base: params.base,
        limits: params.limits,
        versionBytes: params.bytes.byteLength + new TextEncoder().encode(params.name).byteLength,
    });
}

async function applyAppend(
    scope: LockedScope,
    params: Content & { readonly itemId: string; readonly plan: AppendPlan },
) {
    const tx = txOf(scope);
    const item = { ...scope, itemId: params.itemId };
    if (params.plan.drop !== null) {
        const dropped = await execute(
            tx,
            sql`delete from cloud_version where ${isItem(item)} and revision = ${params.plan.drop}`,
        );
        if (!dropped.ok) return dropped;
        invariant(dropped.value === 1, "the gathered droppable version exists under the lock");
    }
    return execute(
        tx,
        sql`insert into cloud_version (account_id, product_id, item_id, revision, name, bytes)
        values (${scope.accountId}, ${scope.productId}, ${params.itemId}, ${params.plan.revision},
        ${params.name}, ${params.bytes})`,
    );
}

type NewItem = CloudScope &
    Content & {
        readonly kind: z.output<typeof ItemKind>;
        readonly limits: CloudLimits;
    };

export async function createItem(tx: Tx, params: NewItem) {
    const locked = await lockCloudScope(tx, params);
    if (!locked.ok) return locked;
    return createLockedItem(locked.value, params);
}

// Import and create both hold the destination scope before gathering its usage.
export async function createLockedItem(
    scope: LockedScope,
    content: Omit<NewItem, keyof CloudScope>,
) {
    const tx = txOf(scope);
    // Measure the same snapshot that is inserted even if the caller reuses its buffer.
    const params = { ...content, bytes: new Uint8Array(content.bytes) };
    const plan = await planAppend(scope, { ...params, itemId: null, base: 0 });
    if (!plan.ok) return plan;
    const item = await queryOne(
        tx,
        z.object({ itemId: z.string() }),
        sql`insert into cloud_item (account_id, product_id, kind)
            values (${scope.accountId}, ${scope.productId}, ${params.kind}) returning item_id::text as "itemId"`,
    );
    if (!item.ok) return item;
    invariant(item.value !== null, "cloud item insert returned no id");
    const written = await applyAppend(scope, { ...params, ...item.value, plan: plan.value });
    if (!written.ok) return written;
    return ok({ itemId: item.value.itemId, revision: plan.value.revision });
}

type Change =
    | { readonly type: "replace"; readonly bytes: Uint8Array }
    | { readonly type: "rename"; readonly name: string }
    | { readonly type: "restore"; readonly revision: number };

export async function changeItem(
    tx: Tx,
    params: CloudItem & {
        readonly change: Change;
        readonly base: number;
        readonly limits: CloudLimits;
    },
) {
    const locked = await lockCloudScope(tx, params);
    if (!locked.ok) return locked;
    const head = await readItem(tx, params);
    if (!head.ok) return head;
    const { change } = params;
    const source = change.type === "restore" ? await readItem(tx, params, change.revision) : head;
    if (!source.ok) return source;
    const content = {
        itemId: params.itemId,
        name: change.type === "rename" ? change.name : source.value.name,
        bytes: change.type === "replace" ? new Uint8Array(change.bytes) : source.value.bytes,
    };
    const plan = await planAppend(locked.value, { ...content, ...params });
    if (!plan.ok) return plan;
    const written = await applyAppend(locked.value, { ...content, plan: plan.value });
    if (!written.ok) return written;
    return ok({ revision: plan.value.revision, conflict: plan.value.conflict });
}

export async function deleteItem(tx: Tx, item: CloudItem) {
    const locked = await lockCloudScope(tx, item);
    if (!locked.ok) return locked;
    const removed = await execute(tx, sql`delete from cloud_item where ${isItem(item)}`);
    if (!removed.ok) return removed;
    return removed.value === 0 ? err({ code: "NOT_FOUND" }) : ok(undefined);
}
