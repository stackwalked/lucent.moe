import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import type { AccountId, ProductId } from "@lucent/core/scalars";
import { ItemKind } from "@lucent/rpc/cloud-item";
import { z } from "zod";
import { execute, type Queryable, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import { type CloudLimits, decideAppend } from "./items.rules.ts";

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

// Take before gathering usage or a head, including first-ever writers in an empty scope. The
// caller already holds the scope's account lock: nothing here takes it, and a writer that
// skipped it would race a suspension.
const scopeLock = Symbol("cloud.scopeLock");
type LockedScope = CloudScope & { readonly [scopeLock]: Tx };

export async function lockCloudScope(tx: Tx, scope: CloudScope) {
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

async function planAppend(
    tx: Tx,
    params: CloudScope &
        Content & {
            readonly head: number;
            readonly base: number;
            readonly limits: CloudLimits;
        },
) {
    const usage = await queryOne(
        tx,
        z.object({ items: z.int(), storedBytes: z.coerce.number().int() }),
        sql`select count(distinct item_id)::integer as items,
            coalesce(sum(octet_length(bytes)::bigint + octet_length(name)), 0) as "storedBytes"
            from cloud_version where ${inScope(params)}`,
    );
    if (!usage.ok) return usage;
    invariant(usage.value !== null, "cloud usage aggregate missing");
    return decideAppend({
        ...params,
        usage: usage.value,
        versionBytes: params.bytes.byteLength + new TextEncoder().encode(params.name).byteLength,
    });
}

function appendVersion(tx: Tx, params: CloudItem & Content & { readonly revision: number }) {
    return execute(
        tx,
        sql`insert into cloud_version (account_id, product_id, item_id, revision, name, bytes)
        values (${params.accountId}, ${params.productId}, ${params.itemId}, ${params.revision},
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
    const tx = scope[scopeLock];
    // Measure the same snapshot that is inserted even if the caller reuses its buffer.
    const params = { ...content, ...scope, bytes: new Uint8Array(content.bytes) };
    const plan = await planAppend(tx, { ...params, head: 0, base: 0 });
    if (!plan.ok) return plan;
    const item = await queryOne(
        tx,
        z.object({ itemId: z.string() }),
        sql`insert into cloud_item (account_id, product_id, kind)
            values (${params.accountId}, ${params.productId}, ${params.kind}) returning item_id::text as "itemId"`,
    );
    if (!item.ok) return item;
    invariant(item.value !== null, "cloud item insert returned no id");
    const written = await appendVersion(tx, { ...params, ...item.value, ...plan.value });
    if (!written.ok) return written;
    return ok({ ...item.value, ...plan.value });
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
        name: change.type === "rename" ? change.name : source.value.name,
        bytes: change.type === "replace" ? new Uint8Array(change.bytes) : source.value.bytes,
    };
    const plan = await planAppend(tx, { ...params, ...content, head: head.value.revision });
    if (!plan.ok) return plan;
    const written = await appendVersion(tx, { ...params, ...content, ...plan.value });
    if (!written.ok) return written;
    return plan;
}

export async function deleteItem(tx: Tx, item: CloudItem) {
    const locked = await lockCloudScope(tx, item);
    if (!locked.ok) return locked;
    const removed = await execute(tx, sql`delete from cloud_item where ${isItem(item)}`);
    if (!removed.ok) return removed;
    return removed.value === 0 ? err({ code: "NOT_FOUND" }) : ok(undefined);
}
