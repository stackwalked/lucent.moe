import type { ProductCatalog } from "@lucent/catalog/catalog";
import { invariant } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { ChannelId, EpochMs, ProductId } from "@lucent/core/scalars";
import type { AuthzRefusal, Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { appendAudit } from "../../base/db/audit.ts";
import { type Db, type DbFailure, queryAll, queryOne, sql, type Tx } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { type Forbidden, lockAuthorized, readAsStaff } from "../../identity/authority/staff.ts";
import {
    type ChangelogEntryFields,
    decideChangelogEntry,
    type InvalidEntry,
    type NamedRelease,
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

const StaffChangelogRow = ChangelogRow.extend({ releaseId: z.string().nullable() });

const ChoosableRelease = z.object({
    id: z.string(),
    productId: ProductId,
    channel: ChannelId,
    number: z.string(),
    stagedAt: EpochMs,
    entryId: z.string().nullable(),
});

// The releases a form can offer: those no entry names yet, and those the listed entries name
// (so editing one shows its own), newest first, each by its highest seal. The form narrows them
// to the entry's subject; the writer's rule is what refuses a mismatch.
export function listStaffNotes(db: Db, params: { readonly caller: Caller }) {
    return readAsStaff(db, { caller: params.caller, actions: [NOTE_ACTION] }, async (q) => {
        const changelog = await queryAll(
            q,
            StaffChangelogRow,
            sql`select ${CHANGELOG_COLUMNS}, encode(release_id, 'hex') as "releaseId"
                from changelog_entry
                order by published_at desc, id desc
                limit ${STAFF_LIMIT + 1}`,
        );
        if (!changelog.ok) return changelog;
        const shown = changelog.value.slice(0, STAFF_LIMIT);
        const releases = await queryAll(
            q,
            ChoosableRelease,
            sql`select encode(r.id, 'hex') as id, r.product_id as "productId", r.channel,
                       s.number::text as number, s.created_at as "stagedAt",
                       e.id::text as "entryId"
                from release r
                join lateral (select number, created_at from release_seal
                              where release_id = r.id order by number desc limit 1) s on true
                left join changelog_entry e on e.release_id = r.id
                where e.id is null or e.id = any(${shown.map((row) => row.id)}::uuid[])
                order by s.created_at desc, r.id desc
                limit ${STAFF_LIMIT}`,
        );
        if (!releases.ok) return releases;
        return ok({
            changelog: shown,
            truncated: changelog.value.length > STAFF_LIMIT,
            releases: releases.value,
        });
    });
}

// The release an entry names, under a lock that keeps another writer from naming it meanwhile,
// and whether another entry already holds it.
async function gatherRelease(
    tx: Tx,
    params: { readonly releaseId: string | null; readonly entryId: string | null },
): Promise<Result<NamedRelease, DbFailure>> {
    if (params.releaseId === null) return ok(null);
    // NO KEY UPDATE: promotion and publishing take KEY SHARE on the release and must not wait.
    const release = await queryOne(
        tx,
        z.object({ product_id: z.string() }),
        sql`select product_id from release where id = decode(${params.releaseId}, 'hex')
            for no key update`,
    );
    if (!release.ok) return release;
    if (release.value === null) return ok(null);
    const other = await queryOne(
        tx,
        IdRow,
        sql`select id::text as id from changelog_entry
            where release_id = decode(${params.releaseId}, 'hex')
              and id is distinct from ${params.entryId}::uuid`,
    );
    if (!other.ok) return other;
    return ok({ productId: release.value.product_id, heldByOther: other.value !== null });
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
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const release = await gatherRelease(tx, { releaseId: fields.releaseId, entryId: null });
        if (!release.ok) return release;
        const valid = decideChangelogEntry(fields, release.value);
        if (!valid.ok) return valid;
        const inserted = await queryOne(
            tx,
            IdRow,
            sql`insert into changelog_entry
                    (subject, product_id, version, title, added, changed, fixed, body,
                     release_id, published_at, updated_at)
                values (${fields.subject}, ${fields.productId}, ${fields.version}, ${fields.title},
                        ${fields.added}, ${fields.changed}, ${fields.fixed}, ${fields.body},
                        decode(${fields.releaseId}, 'hex'), now(), now())
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
    return await withTx(db, async (tx, txNow) => {
        const authorized = await lockAuthorized(tx, {
            caller: params.caller,
            action: NOTE_ACTION,
            txNow,
        });
        if (!authorized.ok) return authorized;
        const release = await gatherRelease(tx, {
            releaseId: fields.releaseId,
            entryId: params.id,
        });
        if (!release.ok) return release;
        const valid = decideChangelogEntry(fields, release.value);
        if (!valid.ok) return valid;
        const updated = await queryOne(
            tx,
            IdRow,
            sql`update changelog_entry
                set subject = ${fields.subject}, product_id = ${fields.productId},
                    version = ${fields.version}, title = ${fields.title},
                    added = ${fields.added}, changed = ${fields.changed}, fixed = ${fields.fixed},
                    body = ${fields.body}, release_id = decode(${fields.releaseId}, 'hex'),
                    updated_at = now()
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
