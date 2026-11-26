import { trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import {
    AccountId,
    ChannelId,
    EntitlementId,
    EpochMs,
    FeatureTag,
    ProductId,
    RoleId,
    toBase64Url,
} from "@lucent/core/scalars";
import { ACTIONS, type Action } from "@lucent/policy/actions";
import { type Caller, can, type Subject } from "@lucent/policy/policy";
import { AccountStatus } from "@lucent/rpc/web";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    type Queryable,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    toTimestamptz,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { type DeviceList, readAccountDevices } from "../devices/devices.ts";
import type { FeatureSelection } from "./entitlements.ts";
import { readStanding } from "./standing.ts";

// What staff read in the admin area. Reads take no locks and need no step-up: `can()` with the
// read permission decides, and every action taken from what was read is decided again under lock.

export const PAGE_SIZE = 50;

export type ReadRefusal =
    | DbFailure
    | { readonly code: "FORBIDDEN" }
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "INVALID_CURSOR" };

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };

// A cursor is the last row's sort key as base64url JSON: opaque to web, checked on the way back.
function toCursor(key: unknown): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(key)));
}

function fromCursor<T>(schema: z.ZodType<T>, cursor: string): Result<T, ReadRefusal> {
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(cursor, { alphabet: "base64url" }),
                ),
            ),
        () => ({ code: "INVALID_CURSOR" as const }),
    );
    if (!decoded.ok) return decoded;
    const parsed = schema.safeParse(decoded.value);
    return parsed.success ? ok(parsed.data) : err({ code: "INVALID_CURSOR" });
}

function paged<Row, T>(
    rows: readonly Row[],
    toItem: (row: Row) => T,
    keyOf: (row: Row) => unknown,
): Page<T> {
    const items = rows.slice(0, PAGE_SIZE);
    const last = items.at(-1);
    return {
        items: items.map(toItem),
        nextCursor: rows.length > PAGE_SIZE && last !== undefined ? toCursor(keyOf(last)) : null,
    };
}

async function readSubject(
    q: Queryable,
    caller: Caller,
    txNow: EpochMs,
): Promise<Result<Subject, ReadRefusal>> {
    const standing = await readStanding(q, caller.accountId, txNow);
    if (!standing.ok) return standing;
    if (standing.value === null) return err({ code: "FORBIDDEN" });
    return ok({ ...standing.value, stepUpAt: caller.stepUpAt });
}

export async function readAs<T>(
    db: Db,
    params: { readonly caller: Caller; readonly allowed: (subject: Subject) => boolean },
    read: (q: Queryable, txNow: EpochMs, subject: Subject) => Promise<Result<T, ReadRefusal>>,
): Promise<Result<T, ReadRefusal>> {
    return await withTx(db, async (tx, txNow) => {
        const subject = await readSubject(tx, params.caller, txNow);
        if (!subject.ok) return subject;
        if (!params.allowed(subject.value)) return err({ code: "FORBIDDEN" });
        return await read(tx, txNow, subject.value);
    });
}

// A tombstone reads as deleted first; whether it was suspended is on the detail's `deletion`.
const statusSql = sql`case
        when a.deleted_at is not null then 'deleted'
        when a.status = 'suspended' then 'suspended'
        when a.is_locked then 'locked'
        when not (exists (select 1 from passkey p where p.account_id = a.id)
                  or (exists (select 1 from password_credential pc where pc.account_id = a.id)
                      and exists (select 1 from totp_credential t
                                  where t.account_id = a.id and t.confirmed)))
            then 'setup_pending'
        else 'active'
    end`;

const lastSeenSql = sql`(select max(s.last_seen_at) from browser_session s where s.account_id = a.id)`;

function heldRolesSql(txNow: EpochMs): SqlFragment {
    return sql`coalesce((select array_agg(r.name order by r.rank desc, r.name)
                         from account_role ar join role r on r.id = ar.role_id
                         where ar.account_id = a.id
                           and (ar.expires_at is null
                                or ar.expires_at > ${toTimestamptz(txNow)}::timestamptz)),
                        '{}')`;
}

const AccountRowSchema = z.object({
    id: AccountId,
    email: z.string().nullable(),
    username: z.string().nullable(),
    status: AccountStatus,
    is_root: z.boolean(),
    created_at: EpochMs,
    last_seen_at: EpochMs.nullable(),
    roles: z.array(z.string()),
});

export type AccountSummary = {
    readonly accountId: AccountId;
    // Null for a deleted account.
    readonly email: string | null;
    readonly username: string | null;
    readonly status: AccountStatus;
    readonly isRoot: boolean;
    readonly createdAt: EpochMs;
    readonly lastSeenAt: EpochMs | null;
    readonly roles: readonly string[];
};

function toAccountSummary(row: z.output<typeof AccountRowSchema>): AccountSummary {
    return {
        accountId: row.id,
        email: row.email,
        username: row.username,
        status: row.status,
        isRoot: row.is_root,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        roles: row.roles,
    };
}

export type AccountFilter = {
    readonly status: AccountStatus | null;
    readonly roleId: RoleId | null;
    // Matches the start of a username or an email.
    readonly text: string | null;
};

const NewestKey = z.tuple([EpochMs, AccountId]);
const createdMs = sql`date_trunc('milliseconds', a.created_at)`;
const UsernameKey = z.tuple([z.boolean(), z.string(), AccountId]);

function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listAccounts(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly filter: AccountFilter;
        readonly sort: "newest" | "username";
        readonly cursor: string | null;
    },
): Promise<Result<Page<AccountSummary>, ReadRefusal>> {
    const allowed = (subject: Subject) => can(subject, "accounts:read");
    return await readAs(db, { caller: params.caller, allowed }, async (q, txNow) => {
        const { status, roleId, text } = params.filter;
        const prefix = text === null ? null : `${escapeLike(text.trim().toLowerCase())}%`;
        const filters = sql`
            (${status}::text is null or ${statusSql} = ${status})
            and (${roleId}::text is null or exists (
                select 1 from account_role ar where ar.account_id = a.id and ar.role_id = ${roleId}
                  and (ar.expires_at is null or ar.expires_at > ${toTimestamptz(txNow)}::timestamptz)))
            and (${prefix}::text is null or a.username like ${prefix} or a.email like ${prefix})`;

        // Byte order ("C"), so pages don't depend on the database's locale; created_at at the
        // cursor's precision (milliseconds), or a row a few microseconds past it could be skipped
        // or repeated across a page boundary.
        let after = sql`true`;
        if (params.cursor !== null && params.sort === "newest") {
            const key = fromCursor(NewestKey, params.cursor);
            if (!key.ok) return key;
            after = sql`(${createdMs}, a.id collate "C") < (${toTimestamptz(key.value[0])}::timestamptz, ${key.value[1]})`;
        }
        if (params.cursor !== null && params.sort === "username") {
            const key = fromCursor(UsernameKey, params.cursor);
            if (!key.ok) return key;
            after = sql`(a.username is null, coalesce(a.username, '') collate "C", a.id collate "C")
                        > (${key.value[0]}, ${key.value[1]}, ${key.value[2]})`;
        }
        const order =
            params.sort === "newest"
                ? sql`order by ${createdMs} desc, a.id collate "C" desc`
                : sql`order by a.username is null, coalesce(a.username, '') collate "C", a.id collate "C"`;

        const rows = await queryAll(
            q,
            AccountRowSchema,
            sql`select a.id, a.email, a.username, ${statusSql} as status, a.is_root, a.created_at,
                       ${lastSeenSql} as last_seen_at, ${heldRolesSql(txNow)} as roles
                from account a
                where ${filters} and ${after}
                ${order}
                limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        return ok(
            paged(rows.value, toAccountSummary, (row) =>
                params.sort === "newest"
                    ? [row.created_at, row.id]
                    : [row.username === null, row.username ?? "", row.id],
            ),
        );
    });
}

const AuditRowSchema = z.object({
    id: z.string(),
    at: EpochMs,
    actor_id: z.string(),
    actor_username: z.string().nullable(),
    operation: z.string(),
    target: z.record(z.string(), z.unknown()),
    target_account_id: AccountId.nullable(),
    target_username: z.string().nullable(),
});

export type AuditEntry = {
    readonly id: string;
    readonly at: EpochMs;
    readonly actor: { readonly id: string; readonly username: string | null };
    readonly operation: string;
    readonly target: {
        readonly accountId: AccountId | null;
        readonly username: string | null;
        readonly detail: Readonly<Record<string, unknown>>;
    };
};

function toAuditEntry(row: z.output<typeof AuditRowSchema>): AuditEntry {
    return {
        id: row.id,
        at: row.at,
        actor: { id: row.actor_id, username: row.actor_username },
        operation: row.operation,
        target: {
            accountId: row.target_account_id,
            username: row.target_username,
            detail: row.target,
        },
    };
}

// The client columns stay out: they're for investigating, through the database.
const auditSelect = sql`select au.id::text as id, au.at, au.actor_id, actor.username as actor_username,
           au.operation, au.target,
           (case when au.target->>'accountId' ~ '^acc_' then au.target->>'accountId' end)
               as target_account_id,
           tgt.username as target_username
    from audit au
    left join account actor on actor.id = au.actor_id
    left join account tgt on tgt.id = au.target->>'accountId'`;

const RECENT_AUDIT = 10;

export type AccountDetail = AccountSummary & {
    readonly signIn: {
        readonly passkeys: number;
        readonly password: boolean;
        readonly totp: boolean;
    };
    readonly heldRoles: readonly {
        readonly roleId: RoleId;
        readonly name: string;
        readonly rank: number;
        readonly permissions: readonly Action[];
        readonly expiresAt: EpochMs | null;
    }[];
    // Null when the reader can't read audit.
    readonly recentAudit: readonly AuditEntry[] | null;
    readonly entitlements: readonly IssuedEntitlement[];
    readonly deletion: AccountDeletion | null;
} & DeviceList;

export type AccountDeletion =
    | { readonly state: "pending"; readonly requestedAt: EpochMs; readonly dueAt: EpochMs }
    | {
          readonly state: "completed";
          readonly completedAt: EpochMs;
          readonly suspended: boolean;
          readonly addressHashKept: boolean;
      };

const DeletionRowSchema = z.object({
    requested_at: EpochMs.nullable(),
    due_at: EpochMs.nullable(),
    deleted_at: EpochMs.nullable(),
    suspended: z.boolean(),
    hash_kept: z.boolean(),
});

function toDeletion(row: z.output<typeof DeletionRowSchema> | null): AccountDeletion | null {
    if (row === null) return null;
    if (row.deleted_at !== null) {
        return {
            state: "completed",
            completedAt: row.deleted_at,
            suspended: row.suspended,
            addressHashKept: row.hash_kept,
        };
    }
    if (row.requested_at !== null && row.due_at !== null) {
        return { state: "pending", requestedAt: row.requested_at, dueAt: row.due_at };
    }
    return null;
}

export type IssuedEntitlement = {
    readonly entitlementId: EntitlementId;
    readonly status: "active" | "suspended" | "revoked";
    readonly validFrom: EpochMs;
    readonly validUntil: EpochMs | null;
    readonly createdAt: EpochMs;
    readonly products: readonly {
        readonly productId: ProductId;
        readonly features: FeatureSelection;
        readonly channels: readonly ChannelId[];
    }[];
};

const EntitlementRowSchema = z.object({
    id: EntitlementId,
    status: z.enum(["active", "suspended", "revoked"]),
    valid_from: EpochMs,
    valid_until: EpochMs.nullable(),
    created_at: EpochMs,
});

const EntitlementProductRowSchema = z.object({
    entitlement_id: EntitlementId,
    product_id: ProductId,
    features: z.union([z.literal("*"), z.array(FeatureTag)]),
    channels: z.array(ChannelId),
});

// Every entitlement the account was issued, newest first, with what each covers.
async function readIssuedEntitlements(
    q: Queryable,
    accountId: AccountId,
): Promise<Result<readonly IssuedEntitlement[], DbFailure>> {
    const rows = await queryAll(
        q,
        EntitlementRowSchema,
        sql`select id, status, valid_from, valid_until, created_at from entitlement
            where account_id = ${accountId} order by created_at desc, id`,
    );
    if (!rows.ok) return rows;
    const products = await queryAll(
        q,
        EntitlementProductRowSchema,
        sql`select ep.entitlement_id, ep.product_id, ep.features, ep.channels
            from entitlement_product ep join entitlement e on e.id = ep.entitlement_id
            where e.account_id = ${accountId} order by ep.product_id`,
    );
    if (!products.ok) return products;
    return ok(
        rows.value.map((row) => ({
            entitlementId: row.id,
            status: row.status,
            validFrom: row.valid_from,
            validUntil: row.valid_until,
            createdAt: row.created_at,
            products: products.value
                .filter((product) => product.entitlement_id === row.id)
                .map((product) => ({
                    productId: product.product_id,
                    features: product.features,
                    channels: product.channels,
                })),
        })),
    );
}

const SignInRowSchema = z.object({
    passkeys: z.coerce.number().int(),
    password: z.boolean(),
    totp: z.boolean(),
});

const HeldRoleRowSchema = z.object({
    role_id: RoleId,
    name: z.string(),
    rank: z.number().int(),
    permissions: z.array(z.string()),
    expires_at: EpochMs.nullable(),
});

export async function readAccount(
    db: Db,
    params: { readonly caller: Caller; readonly accountId: AccountId },
): Promise<Result<AccountDetail, ReadRefusal>> {
    const allowed = (subject: Subject) => can(subject, "accounts:read");
    return await readAs(db, { caller: params.caller, allowed }, async (q, txNow, subject) => {
        const row = await queryOne(
            q,
            AccountRowSchema,
            sql`select a.id, a.email, a.username, ${statusSql} as status, a.is_root, a.created_at,
                       ${lastSeenSql} as last_seen_at, ${heldRolesSql(txNow)} as roles
                from account a where a.id = ${params.accountId}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" });
        const signIn = await queryOne(
            q,
            SignInRowSchema,
            sql`select
                    (select count(*) from passkey where account_id = ${params.accountId}) as passkeys,
                    exists (select 1 from password_credential
                            where account_id = ${params.accountId}) as password,
                    exists (select 1 from totp_credential
                            where account_id = ${params.accountId} and confirmed) as totp`,
        );
        if (!signIn.ok) return signIn;
        const held = await queryAll(
            q,
            HeldRoleRowSchema,
            sql`select r.id as role_id, r.name, r.rank, r.permissions, ar.expires_at
                from account_role ar join role r on r.id = ar.role_id
                where ar.account_id = ${params.accountId}
                  and (ar.expires_at is null or ar.expires_at > ${toTimestamptz(txNow)}::timestamptz)
                order by r.rank desc, r.name`,
        );
        if (!held.ok) return held;
        let recentAudit: AuditEntry[] | null = null;
        if (can(subject, "audit:read")) {
            const audit = await queryAll(
                q,
                AuditRowSchema,
                sql`${auditSelect}
                    where au.actor_id = ${params.accountId}
                       or au.target->>'accountId' = ${params.accountId}
                    order by au.id desc limit ${RECENT_AUDIT}`,
            );
            if (!audit.ok) return audit;
            recentAudit = audit.value.map(toAuditEntry);
        }
        const entitlements = await readIssuedEntitlements(q, params.accountId);
        if (!entitlements.ok) return entitlements;
        const devices = await readAccountDevices(q, { accountId: params.accountId, txNow });
        if (!devices.ok) return devices;
        const deletion = await queryOne(
            q,
            DeletionRowSchema,
            sql`select deletion_requested_at as requested_at, deletion_due_at as due_at,
                       deleted_at, coalesce(suspended_at_deletion, false) as suspended,
                       email_hash is not null as hash_kept
                from account where id = ${params.accountId}`,
        );
        if (!deletion.ok) return deletion;
        return ok({
            deletion: toDeletion(deletion.value),
            ...toAccountSummary(row.value),
            signIn: signIn.value ?? { passkeys: 0, password: false, totp: false },
            heldRoles: held.value.map((role) => ({
                roleId: role.role_id,
                name: role.name,
                rank: role.rank,
                permissions: knownActions(role.permissions),
                expiresAt: role.expires_at,
            })),
            recentAudit,
            entitlements: entitlements.value,
            ...devices.value,
        });
    });
}

export type AuditFilter = {
    readonly actorId: string | null;
    readonly targetAccountId: AccountId | null;
    readonly operation: string | null;
    readonly before: EpochMs | null;
};

const AuditKey = z.string().regex(/^[0-9]{1,19}$/);

export async function listAudit(
    db: Db,
    params: {
        readonly caller: Caller;
        readonly filter: AuditFilter;
        readonly cursor: string | null;
    },
): Promise<Result<Page<AuditEntry>, ReadRefusal>> {
    const allowed = (subject: Subject) => can(subject, "audit:read");
    return await readAs(db, { caller: params.caller, allowed }, async (q) => {
        let after = sql`true`;
        if (params.cursor !== null) {
            const key = fromCursor(AuditKey, params.cursor);
            if (!key.ok) return key;
            after = sql`au.id < ${key.value}::bigint`;
        }
        const { actorId, targetAccountId, operation, before } = params.filter;
        const beforeIso = before === null ? null : toTimestamptz(before);
        const rows = await queryAll(
            q,
            AuditRowSchema,
            sql`${auditSelect}
                where ${after}
                  and (${actorId}::text is null or au.actor_id = ${actorId})
                  and (${targetAccountId}::text is null
                       or au.target->>'accountId' = ${targetAccountId})
                  and (${operation}::text is null or au.operation = ${operation})
                  and (${beforeIso}::timestamptz is null or au.at < ${beforeIso}::timestamptz)
                order by au.id desc
                limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        return ok(paged(rows.value, toAuditEntry, (row) => row.id));
    });
}

function knownActions(stored: readonly string[]): readonly Action[] {
    return stored.filter((permission): permission is Action => ACTION_SET.has(permission));
}

const ACTION_SET: ReadonlySet<string> = new Set<string>(ACTIONS);

const RoleRowSchema = z.object({
    id: RoleId,
    name: z.string(),
    rank: z.number().int(),
    permissions: z.array(z.string()),
    holders: z.coerce.number().int(),
    labelColor: z.enum(["pink", "shu", "ok", "wait", "violet", "aqua"]).nullable(),
});

export type RoleSummary = {
    readonly roleId: RoleId;
    readonly name: string;
    readonly rank: number;
    readonly permissions: readonly Action[];
    // Stored strings no Action matches any more: they grant nothing, and saving the role drops them.
    readonly unknownPermissions: readonly string[];
    readonly holders: number;
    readonly labelColor: "pink" | "shu" | "ok" | "wait" | "violet" | "aqua" | null;
};

function toRoleSummary(row: z.output<typeof RoleRowSchema>): RoleSummary {
    return {
        roleId: row.id,
        name: row.name,
        rank: row.rank,
        permissions: knownActions(row.permissions),
        unknownPermissions: row.permissions.filter((permission) => !ACTION_SET.has(permission)),
        holders: row.holders,
        labelColor: row.labelColor,
    };
}

function roleSelect(txNow: EpochMs): SqlFragment {
    return sql`select r.id, r.name, r.rank, r.permissions, r.label_color as "labelColor",
                      (select count(*) from account_role ar
                       where ar.role_id = r.id
                         and (ar.expires_at is null
                              or ar.expires_at > ${toTimestamptz(txNow)}::timestamptz)) as holders
               from role r`;
}

// Roles are few; listed whole, highest rank first. Anyone who assigns or edits roles sees them.
function readsRoles(subject: Subject): boolean {
    return can(subject, "roles:assign") || can(subject, "roles:manage");
}

export async function listRoles(
    db: Db,
    params: { readonly caller: Caller },
): Promise<Result<readonly RoleSummary[], ReadRefusal>> {
    return await readAs(db, { caller: params.caller, allowed: readsRoles }, async (q, txNow) => {
        const rows = await queryAll(
            q,
            RoleRowSchema,
            sql`${roleSelect(txNow)} order by r.rank desc, r.name`,
        );
        if (!rows.ok) return rows;
        return ok(rows.value.map(toRoleSummary));
    });
}

export async function readRoleSummary(
    db: Db,
    params: { readonly caller: Caller; readonly roleId: RoleId },
): Promise<Result<RoleSummary, ReadRefusal>> {
    return await readAs(db, { caller: params.caller, allowed: readsRoles }, async (q, txNow) => {
        const row = await queryOne(
            q,
            RoleRowSchema,
            sql`${roleSelect(txNow)} where r.id = ${params.roleId}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err({ code: "NOT_FOUND" });
        return ok(toRoleSummary(row.value));
    });
}
