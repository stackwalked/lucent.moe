import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import type { AuditOperation } from "@lucent/policy/operations";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { type Forbidden, lockAuthorized, readAsStaff } from "../authority/staff.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, queryAll, queryOne, sql } from "../db/pool.ts";
import { withTx } from "../db/tx.ts";

// Known issues and changelog entries: what staff tell the public about a product, or about the
// service (no product). Writing one takes releases:promote, with its step-up and audit, as
// publishing a resource does: it is a release of words. They show without a deploy; the public
// reads are in status.ts.

export const NOTE_ACTION = "releases:promote";

// The staff list shows this many of each, newest first.
const STAFF_LIMIT = 200;

export type NoteKind = "issue" | "changelog";

const TABLES = {
    issue: {
        table: sql`known_issue`,
        at: sql`opened_at`,
        operations: {
            add: "known_issue.add",
            update: "known_issue.update",
            delete: "known_issue.delete",
        },
    },
    changelog: {
        table: sql`changelog_entry`,
        at: sql`published_at`,
        operations: {
            add: "changelog.add",
            update: "changelog.update",
            delete: "changelog.delete",
        },
    },
} as const satisfies Record<
    NoteKind,
    {
        readonly table: unknown;
        readonly at: unknown;
        readonly operations: Record<"add" | "update" | "delete", AuditOperation>;
    }
>;

export type NoteFields = {
    readonly productId: ProductId | null;
    readonly title: string;
    readonly body: string;
};

type NoteRefusal =
    | AuthzRefusal
    | Forbidden
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "UNKNOWN_PRODUCT" };

const IdRow = z.object({ id: z.string() });

const IssueRow = z.object({
    id: z.string(),
    productId: ProductId.nullable(),
    title: z.string(),
    body: z.string(),
    openedAt: EpochMs,
    updatedAt: EpochMs,
    closedAt: EpochMs.nullable(),
});

const ChangelogRow = z.object({
    id: z.string(),
    productId: ProductId.nullable(),
    title: z.string(),
    body: z.string(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

export function listStaffNotes(db: Db, params: { readonly caller: Caller }) {
    return readAsStaff(db, { caller: params.caller, actions: [NOTE_ACTION] }, async (q) => {
        const issues = await queryAll(
            q,
            IssueRow,
            sql`select id::text as id, product_id as "productId", title, body,
                       opened_at as "openedAt", updated_at as "updatedAt", closed_at as "closedAt"
                from known_issue order by opened_at desc, id desc limit ${STAFF_LIMIT + 1}`,
        );
        if (!issues.ok) return issues;
        const changelog = await queryAll(
            q,
            ChangelogRow,
            sql`select id::text as id, product_id as "productId", title, body,
                       published_at as "publishedAt", updated_at as "updatedAt"
                from changelog_entry order by published_at desc, id desc
                limit ${STAFF_LIMIT + 1}`,
        );
        if (!changelog.ok) return changelog;
        return ok({
            issues: issues.value.slice(0, STAFF_LIMIT),
            changelog: changelog.value.slice(0, STAFF_LIMIT),
            truncated: issues.value.length > STAFF_LIMIT || changelog.value.length > STAFF_LIMIT,
        });
    });
}

// A product the catalog has, seed or not: staff may write ahead of a launch. Only what the public
// home lists is ever read publicly.
function knownProduct(catalog: ProductCatalog, productId: ProductId | null) {
    return productId === null || catalog.has(productId);
}

export async function addNote(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly kind: NoteKind;
        readonly fields: NoteFields;
    },
): Promise<Result<{ readonly id: string }, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const kind = TABLES[params.kind];
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const inserted = await queryOne(
            tx,
            IdRow,
            sql`insert into ${kind.table} (product_id, title, body, ${kind.at}, updated_at)
                values (${fields.productId}, ${fields.title}, ${fields.body}, now(), now())
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returns its row");
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.add,
            target: { id: inserted.value.id, productId: fields.productId, title: fields.title },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ id: inserted.value.id });
    });
}

export async function updateNote(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly kind: NoteKind;
        readonly id: string;
        readonly fields: NoteFields;
    },
): Promise<Result<void, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const kind = TABLES[params.kind];
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const updated = await queryOne(
            tx,
            IdRow,
            sql`update ${kind.table}
                set product_id = ${fields.productId}, title = ${fields.title},
                    body = ${fields.body}, updated_at = now()
                where id = ${params.id}::uuid
                returning id::text as id`,
        );
        if (!updated.ok) return updated;
        if (updated.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.update,
            target: { id: params.id, productId: fields.productId, title: fields.title },
            at: txNow,
        });
    });
}

export async function deleteNote(
    db: Db,
    params: { readonly caller: Caller; readonly kind: NoteKind; readonly id: string },
): Promise<Result<void, NoteRefusal | DbFailure>> {
    const kind = TABLES[params.kind];
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const deleted = await queryOne(
            tx,
            z.object({ product_id: ProductId.nullable(), title: z.string() }),
            sql`delete from ${kind.table} where id = ${params.id}::uuid
                returning product_id, title`,
        );
        if (!deleted.ok) return deleted;
        if (deleted.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.delete,
            target: {
                id: params.id,
                productId: deleted.value.product_id,
                title: deleted.value.title,
            },
            at: txNow,
        });
    });
}

// Closing a closed issue changes nothing and records nothing.
export async function closeIssue(
    db: Db,
    params: { readonly caller: Caller; readonly id: string },
): Promise<Result<void, NoteRefusal | DbFailure>> {
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const found = await queryOne(
            tx,
            z.object({ product_id: ProductId.nullable(), title: z.string(), closed: z.boolean() }),
            sql`select product_id, title, closed_at is not null as closed from known_issue
                where id = ${params.id}::uuid for update`,
        );
        if (!found.ok) return found;
        if (found.value === null) return err({ code: "NOT_FOUND" as const });
        if (found.value.closed) return ok(undefined);
        const closed = await queryOne(
            tx,
            IdRow,
            sql`update known_issue set closed_at = now(), updated_at = now()
                where id = ${params.id}::uuid returning id::text as id`,
        );
        if (!closed.ok) return closed;
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "known_issue.close",
            target: {
                id: params.id,
                productId: found.value.product_id,
                title: found.value.title,
            },
            at: txNow,
        });
    });
}
