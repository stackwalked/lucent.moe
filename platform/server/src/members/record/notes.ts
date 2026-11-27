import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import { type Db, type DbFailure, queryAll, queryOne, sql } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../../identity/authority/staff.ts";
import {
    type ChangelogEntryFields,
    decideChangelogEntry,
    type InvalidEntry,
} from "./notes.rules.ts";

// Changelog entries: what staff tell the members about a product, the loader, or the service.
// Writing one takes releases:promote, with its step-up and audit, as publishing a resource does:
// it is a release of words. They show without a deploy; the member reads are in status.ts.

export const NOTE_ACTION = "releases:promote";

// The staff list shows this many, newest first.
const STAFF_LIMIT = 200;

type NoteRefusal =
    | AuthzRefusal
    | Forbidden
    | InvalidEntry
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "UNKNOWN_PRODUCT" };

const IdRow = z.object({ id: z.string() });

export const ChangelogRow = z.object({
    id: z.string(),
    subject: z.enum(["product", "loader", "service"]),
    productId: ProductId.nullable(),
    version: z.string().nullable(),
    title: z.string().nullable(),
    added: z.array(z.string()),
    changed: z.array(z.string()),
    fixed: z.array(z.string()),
    body: z.string(),
    publishedAt: EpochMs,
    updatedAt: EpochMs,
});

export const CHANGELOG_COLUMNS = sql`id::text as id, subject, product_id as "productId",
    version, title, added, changed, fixed, body,
    published_at as "publishedAt", updated_at as "updatedAt"`;

export function listStaffNotes(db: Db, params: { readonly caller: Caller }) {
    return readAsStaff(db, { caller: params.caller, actions: [NOTE_ACTION] }, async (q) => {
        const changelog = await queryAll(
            q,
            ChangelogRow,
            sql`select ${CHANGELOG_COLUMNS} from changelog_entry
                order by published_at desc, id desc
                limit ${STAFF_LIMIT + 1}`,
        );
        if (!changelog.ok) return changelog;
        return ok({
            changelog: changelog.value.slice(0, STAFF_LIMIT),
            truncated: changelog.value.length > STAFF_LIMIT,
        });
    });
}

// A product the catalog has, seed or not: staff may write ahead of a launch. Only what a member
// may see is ever read back to members.
function knownProduct(catalog: ProductCatalog, productId: ProductId | null) {
    return productId === null || catalog.has(productId);
}

// What the audit calls an entry: its title or version — the entry rule guarantees one of them
// by the time a write is audited.
function entryTitle(fields: ChangelogEntryFields): string {
    const named = fields.title ?? fields.version;
    invariant(named !== null, "an entry has a title or a version");
    return named;
}

export async function addNote(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly fields: ChangelogEntryFields;
    },
): Promise<Result<{ readonly id: string }, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const valid = decideChangelogEntry(fields);
    if (!valid.ok) return valid;
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
            sql`insert into changelog_entry
                    (subject, product_id, version, title, added, changed, fixed, body,
                     published_at, updated_at)
                values (${fields.subject}, ${fields.productId}, ${fields.version}, ${fields.title},
                        ${fields.added}, ${fields.changed}, ${fields.fixed}, ${fields.body},
                        now(), now())
                returning id::text as id`,
        );
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returns its row");
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "changelog.add",
            target: {
                id: inserted.value.id,
                productId: fields.productId,
                title: entryTitle(fields),
            },
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
        readonly id: string;
        readonly fields: ChangelogEntryFields;
    },
): Promise<Result<void, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const valid = decideChangelogEntry(fields);
    if (!valid.ok) return valid;
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
            sql`update changelog_entry
                set subject = ${fields.subject}, product_id = ${fields.productId},
                    version = ${fields.version}, title = ${fields.title},
                    added = ${fields.added}, changed = ${fields.changed}, fixed = ${fields.fixed},
                    body = ${fields.body}, updated_at = now()
                where id = ${params.id}::uuid
                returning id::text as id`,
        );
        if (!updated.ok) return updated;
        if (updated.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "changelog.update",
            target: {
                id: params.id,
                productId: fields.productId,
                title: entryTitle(fields),
            },
            at: txNow,
        });
    });
}

export async function deleteNote(
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
        const deleted = await queryOne(
            tx,
            z.object({
                product_id: ProductId.nullable(),
                title: z.string().nullable(),
                version: z.string().nullable(),
            }),
            sql`delete from changelog_entry where id = ${params.id}::uuid
                returning product_id, title, version`,
        );
        if (!deleted.ok) return deleted;
        if (deleted.value === null) return err({ code: "NOT_FOUND" as const });
        const named = deleted.value.title ?? deleted.value.version;
        invariant(named !== null, "an entry has a title or a version");
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "changelog.delete",
            target: {
                id: params.id,
                productId: deleted.value.product_id,
                title: named,
            },
            at: txNow,
        });
    });
}
