import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { EpochMs, ProductId } from "@lucent/core/scalars";
import type { AuditOperation } from "@lucent/policy/operations";
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

// Known issues and changelog entries: what staff tell the members about a product, the loader,
// or the service. Writing one takes releases:promote, with its step-up and audit, as publishing
// a resource does: it is a release of words. They show without a deploy; the member reads are in
// status.ts.

export const NOTE_ACTION = "releases:promote";

// The staff list shows this many of each, newest first.
const STAFF_LIMIT = 200;

export type NoteKind = "issue" | "changelog";

const TABLES = {
    issue: {
        table: sql`known_issue`,
        operations: {
            add: "known_issue.add",
            update: "known_issue.update",
            delete: "known_issue.delete",
        },
    },
    changelog: {
        table: sql`changelog_entry`,
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
        readonly operations: Record<"add" | "update" | "delete", AuditOperation>;
    }
>;

export type IssueNoteFields = {
    readonly productId: ProductId | null;
    readonly title: string;
    readonly body: string;
};

export type NoteFieldsOf<K extends NoteKind> = K extends "changelog"
    ? ChangelogEntryFields
    : IssueNoteFields;

type NoteRefusal =
    | AuthzRefusal
    | Forbidden
    | InvalidEntry
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
            sql`select ${CHANGELOG_COLUMNS} from changelog_entry
                order by published_at desc, id desc
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

// A product the catalog has, seed or not: staff may write ahead of a launch. Only what a member
// may see is ever read back to members.
function knownProduct(catalog: ProductCatalog, productId: ProductId | null) {
    return productId === null || catalog.has(productId);
}

type AnyNoteFields = ChangelogEntryFields | IssueNoteFields;

// Changelog fields carry a subject; issue fields never do.
function isEntry(fields: AnyNoteFields): fields is ChangelogEntryFields {
    return "subject" in fields;
}

// What the audit calls a note: an issue its title, an entry its title or version — the entry
// rule guarantees one of them by the time a write is audited.
function noteTitle(fields: AnyNoteFields): string {
    if (!isEntry(fields)) return fields.title;
    const named = fields.title ?? fields.version;
    invariant(named !== null, "an entry has a title or a version");
    return named;
}

function insertSql(fields: AnyNoteFields): ReturnType<typeof sql> {
    if (isEntry(fields)) {
        const entry = fields;
        return sql`insert into changelog_entry
                (subject, product_id, version, title, added, changed, fixed, body,
                 published_at, updated_at)
            values (${entry.subject}, ${entry.productId}, ${entry.version}, ${entry.title},
                    ${entry.added}, ${entry.changed}, ${entry.fixed}, ${entry.body},
                    now(), now())
            returning id::text as id`;
    }
    const issue = fields;
    return sql`insert into known_issue (product_id, title, body, opened_at, updated_at)
        values (${issue.productId}, ${issue.title}, ${issue.body}, now(), now())
        returning id::text as id`;
}

function updateSql(id: string, fields: AnyNoteFields): ReturnType<typeof sql> {
    if (isEntry(fields)) {
        const entry = fields;
        return sql`update changelog_entry
            set subject = ${entry.subject}, product_id = ${entry.productId},
                version = ${entry.version}, title = ${entry.title},
                added = ${entry.added}, changed = ${entry.changed}, fixed = ${entry.fixed},
                body = ${entry.body}, updated_at = now()
            where id = ${id}::uuid
            returning id::text as id`;
    }
    const issue = fields;
    return sql`update known_issue
        set product_id = ${issue.productId}, title = ${issue.title},
            body = ${issue.body}, updated_at = now()
        where id = ${id}::uuid
        returning id::text as id`;
}

function checked(fields: AnyNoteFields): Result<void, InvalidEntry> {
    if (!isEntry(fields)) return ok(undefined);
    const decided = decideChangelogEntry(fields);
    return decided.ok ? ok(undefined) : decided;
}

export async function addNote<K extends NoteKind>(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly kind: K;
        readonly fields: NoteFieldsOf<K>;
    },
): Promise<Result<{ readonly id: string }, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const valid = checked(fields);
    if (!valid.ok) return valid;
    const kind = TABLES[params.kind];
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const inserted = await queryOne(tx, IdRow, insertSql(fields));
        if (!inserted.ok) return inserted;
        invariant(inserted.value !== null, "an insert returns its row");
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.add,
            target: {
                id: inserted.value.id,
                productId: fields.productId,
                title: noteTitle(fields),
            },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ id: inserted.value.id });
    });
}

export async function updateNote<K extends NoteKind>(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly catalog: ProductCatalog;
        readonly kind: K;
        readonly id: string;
        readonly fields: NoteFieldsOf<K>;
    },
): Promise<Result<void, NoteRefusal | DbFailure>> {
    const { fields } = params;
    if (!knownProduct(params.catalog, fields.productId)) return err({ code: "UNKNOWN_PRODUCT" });
    const valid = checked(fields);
    if (!valid.ok) return valid;
    const kind = TABLES[params.kind];
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const updated = await queryOne(tx, IdRow, updateSql(params.id, fields));
        if (!updated.ok) return updated;
        if (updated.value === null) return err({ code: "NOT_FOUND" as const });
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.update,
            target: {
                id: params.id,
                productId: fields.productId,
                title: noteTitle(fields),
            },
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
            z.object({
                product_id: ProductId.nullable(),
                title: z.string().nullable(),
                version: z.string().nullable(),
            }),
            sql`delete from ${kind.table} where id = ${params.id}::uuid
                returning product_id, title,
                    ${params.kind === "changelog" ? sql`version` : sql`null`} as version`,
        );
        if (!deleted.ok) return deleted;
        if (deleted.value === null) return err({ code: "NOT_FOUND" as const });
        const named = deleted.value.title ?? deleted.value.version;
        invariant(named !== null, "an entry has a title or a version");
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: kind.operations.delete,
            target: {
                id: params.id,
                productId: deleted.value.product_id,
                title: named,
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
