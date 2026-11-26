import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import {
    type Db,
    type DbFailure,
    execute,
    queryAll,
    queryOne,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { readEffectiveProductAccess } from "../../identity/authority/entitlements.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../../identity/authority/staff.ts";
import { withMember } from "../notify/account.ts";
import { findResourceFile } from "./resource-files.ts";

// Files staff publish for members. Publishing, editing and removing one takes releases:promote,
// with its step-up and audit: putting a file in front of members is a release of its own kind.
// A resource naming a product shows to members entitled to it; one naming none, to every member.

export const RESOURCE_ACTION = "releases:promote";

// The staff list shows them all, newest first, up to this many.
const STAFF_LIMIT = 200;

const ResourceRow = z.object({
    id: z.string(),
    productId: ProductId.nullable(),
    title: z.string(),
    description: z.string(),
    fileName: z.string(),
    digest: z.string(),
    size: z.coerce.number().int().positive(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

const COLUMNS = sql`r.id::text as id, r.product_id as "productId", r.title, r.description,
    r.file_name as "fileName", r.digest, r.size, r.published_at as "publishedAt",
    r.updated_at as "updatedAt"`;

export type Resource = z.output<typeof ResourceRow>;

// Whether the member may have a resource: entitled to its product now, or it names none. A
// product the catalog no longer has entitles nobody.
async function visibleTo(
    tx: Tx,
    params: { readonly accountId: AccountId; readonly catalog: ProductCatalog },
    productIds: readonly (ProductId | null)[],
): Promise<Result<ReadonlySet<ProductId | null>, DbFailure>> {
    const visible = new Set<ProductId | null>([null]);
    for (const productId of new Set(productIds)) {
        if (productId === null) continue;
        const product = params.catalog.get(productId);
        if (product === undefined) continue;
        const access = await readEffectiveProductAccess(tx, {
            accountId: params.accountId,
            product,
            at: "transaction",
        });
        if (!access.ok) return access;
        if (access.value.isEntitled) visible.add(productId);
    }
    return ok(visible);
}

export function listMemberResources(
    db: Db,
    token: BearerToken,
    params: { readonly catalog: ProductCatalog },
) {
    return withMember(db, token, async (tx, accountId) => {
        const rows = await queryAll(
            tx,
            ResourceRow,
            sql`select ${COLUMNS} from resource r order by r.published_at desc, r.id desc
                limit ${STAFF_LIMIT}`,
        );
        if (!rows.ok) return rows;
        const visible = await visibleTo(
            tx,
            { accountId, catalog: params.catalog },
            rows.value.map((row) => row.productId),
        );
        if (!visible.ok) return visible;
        return ok(rows.value.filter((row) => visible.value.has(row.productId)));
    });
}

// The one resource a member asked to download, if they may have it; anything else is NOT_FOUND.
export function readMemberResource(
    db: Db,
    token: BearerToken,
    params: { readonly catalog: ProductCatalog; readonly resourceId: string },
) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            ResourceRow,
            sql`select ${COLUMNS} from resource r where r.id = ${params.resourceId}::uuid`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" as const });
        const visible = await visibleTo(tx, { accountId, catalog: params.catalog }, [
            row.value.productId,
        ]);
        if (!visible.ok) return visible;
        if (!visible.value.has(row.value.productId)) return err({ code: "NOT_FOUND" as const });
        return ok(row.value);
    });
}

const StaffRow = ResourceRow.extend({
    publishedBy: AccountId,
    publisherUsername: z.string().nullable(),
});

export function listStaffResources(db: Db, params: { readonly caller: Caller }) {
    return readAsStaff(db, { caller: params.caller, actions: [RESOURCE_ACTION] }, async (q) => {
        const rows = await queryAll(
            q,
            StaffRow,
            sql`select ${COLUMNS}, r.published_by as "publishedBy",
                       a.username as "publisherUsername"
                from resource r join account a on a.id = r.published_by
                order by r.published_at desc, r.id desc limit ${STAFF_LIMIT + 1}`,
        );
        if (!rows.ok) return rows;
        return ok({
            items: rows.value
                .slice(0, STAFF_LIMIT)
                .map(({ publishedBy, publisherUsername, ...r }) => ({
                    ...r,
                    publishedBy: { id: publishedBy, username: publisherUsername },
                })),
            truncated: rows.value.length > STAFF_LIMIT,
        });
    });
}

// Whether staff may upload at all, asked before any byte is written: the upload route checks it,
// then streams outside any transaction.
export function authorizeResourceUpload(db: Db, params: { readonly caller: Caller }) {
    return withTx(db, (tx, txNow) =>
        lockAuthorized(tx, { caller: params.caller, action: RESOURCE_ACTION, txNow }),
    );
}

// Marks a stored file as one staff uploaded: only such a digest can be published. The same
// bytes uploaded again are the same file and keep their first record.
export function recordResourceUpload(
    db: Db,
    params: { readonly caller: Caller; readonly digest: string; readonly size: number },
) {
    return execute(
        db,
        sql`insert into resource_upload (digest, size, uploaded_by, uploaded_at)
            values (${params.digest}, ${params.size}, ${params.caller.accountId}, now())
            on conflict (digest) do nothing`,
    );
}

export type ResourceFields = {
    readonly productId: ProductId | null;
    readonly title: string;
    readonly description: string;
    readonly fileName: string;
};

type ResourceRefusal =
    | AuthzRefusal
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "UNKNOWN_PRODUCT" }
    | Forbidden;

function knownProduct(catalog: ProductCatalog, productId: ProductId | null) {
    return productId === null || catalog.has(productId);
}

// Publishes a file uploaded earlier under its digest. The file is looked up before the
// transaction: no filesystem I/O happens under it.
export async function publishResource(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly artifactDir: string | null;
        readonly digest: string;
        readonly fields: ResourceFields;
    },
): Promise<Result<{ readonly resourceId: string }, ResourceRefusal | DbFailure>> {
    if (!knownProduct(params.catalog, params.fields.productId)) {
        return err({ code: "UNKNOWN_PRODUCT" });
    }
    const size =
        params.artifactDir === null
            ? null
            : await findResourceFile(params.artifactDir, params.digest);
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: RESOURCE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        // Asked after authorizing, so who may not publish learns nothing of what is stored.
        if (size === null) return err({ code: "NOT_FOUND" as const });
        // The file being there is not enough: builds are stored beside resources.
        const uploaded = await queryOne(
            tx,
            z.object({ digest: z.string() }),
            sql`select digest from resource_upload where digest = ${params.digest}`,
        );
        if (!uploaded.ok) return uploaded;
        if (uploaded.value === null) return err({ code: "NOT_FOUND" as const });
        const { fields } = params;
        const inserted = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`insert into resource (product_id, title, description, file_name, digest, size,
                                      published_by, published_at, updated_at)
                values (${fields.productId}, ${fields.title}, ${fields.description},
                        ${fields.fileName}, ${params.digest}, ${size}, ${params.caller.accountId},
                        now(), now())
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returns its row");
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "resource.publish",
            target: {
                resourceId: inserted.value.id,
                productId: fields.productId,
                title: fields.title,
                digest: params.digest,
                size,
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ resourceId: inserted.value.id });
    });
}

export async function updateResource(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly resourceId: string;
        readonly fields: ResourceFields;
    },
): Promise<Result<void, ResourceRefusal | DbFailure>> {
    if (!knownProduct(params.catalog, params.fields.productId)) {
        return err({ code: "UNKNOWN_PRODUCT" });
    }
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: RESOURCE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const { fields } = params;
        const updated = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`update resource
                set product_id = ${fields.productId}, title = ${fields.title},
                    description = ${fields.description}, file_name = ${fields.fileName},
                    updated_at = now()
                where id = ${params.resourceId}::uuid
                returning id::text as id`,
        );
        if (!updated.ok) return updated;
        if (updated.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "resource.update",
            target: {
                resourceId: params.resourceId,
                productId: fields.productId,
                title: fields.title,
            },
            at: txNow,
        });
    });
}

// The row goes; the bytes stay under their digest, which another resource or a loader release
// may share.
export async function deleteResource(
    db: Db,
    params: { readonly caller: Caller; readonly resourceId: string },
): Promise<Result<void, ResourceRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: RESOURCE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const deleted = await queryOne(
            tx,
            z.object({ title: z.string(), digest: z.string() }),
            sql`delete from resource where id = ${params.resourceId}::uuid
                returning title, digest`,
        );
        if (!deleted.ok) return deleted;
        if (deleted.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "resource.delete",
            target: { resourceId: params.resourceId, ...deleted.value },
            at: txNow,
        });
    });
}
