import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import type { CryptoRng } from "@lucent/core/rng";
import {
    AccountId,
    type BearerToken,
    type ChannelId,
    EntitlementId,
    type EpochMs,
    newAccountId,
    newEntitlementId,
    type OperationId,
    type ProductId,
    RoleId,
} from "@lucent/core/scalars";
import type { Action } from "@lucent/policy/actions";
import { type AuthzRefusal, authorize, type Caller } from "@lucent/policy/policy";
import { z } from "zod";
import { clearCredentials, issueSetupToken } from "../auth/setup.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, execute, queryOne, sql, toTimestamptz } from "../db/pool.ts";
import { type ReceiptRefusal, readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { withTx } from "../db/tx.ts";
import type { FeatureSelection } from "./entitlements.ts";
import {
    type ChannelGrant,
    lockCallerWith,
    lockRole,
    readRole,
    type StoredRole,
} from "./standing.ts";
import { parseUsername, type UsernameInvalid } from "./usernames.ts";

export type WriterFailure =
    | DbFailure
    | AuthzRefusal
    | ReceiptRefusal
    | UsernameInvalid
    | { readonly code: "NOT_FOUND" }
    | { readonly code: "ROOT_ALREADY_EXISTS" }
    | { readonly code: "EMAIL_TAKEN" }
    | { readonly code: "USERNAME_TAKEN" }
    | { readonly code: "INVALID_RANK" }
    | { readonly code: "UNKNOWN_PRODUCT"; readonly productId: ProductId }
    | {
          readonly code: "UNKNOWN_CHANNEL";
          readonly productId: ProductId;
          readonly channel: ChannelId;
      }
    | { readonly code: "NO_PRODUCTS" }
    | { readonly code: "INVALID_WINDOW" }
    | { readonly code: "ROLE_NAME_TAKEN" };

// What a staff-facing writer can refuse with, besides its own codes: every one locks the caller
// and authorizes; most keep a receipt.
type Refusal<Code extends string> = { readonly code: Code };
type StaffFailure<Extra> = DbFailure | AuthzRefusal | Extra;

// `role.rank` is a PostgreSQL integer.
const MAX_RANK = 2_147_483_647;

function principalOf(caller: Caller): string {
    return `account:${caller.accountId}`;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
    return [...new Set(values)].sort();
}

export async function bootstrapRootAccount(params: {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly email: string;
    readonly username: string;
}): Promise<
    Result<{ readonly accountId: AccountId; readonly setupToken: BearerToken }, WriterFailure>
> {
    const parsedName = parseUsername(params.username);
    if (!parsedName.ok) return parsedName;
    const normalizedEmail = params.email.trim().toLowerCase();
    const accountId = newAccountId(params.rng);

    return await withTx(params.db, async (tx, txNow) => {
        // Checked first: with the root's own email or username, the insert below would trip
        // that unique key before the single-root index and misreport a rerun as a conflict.
        const rootRes = await queryOne(
            tx,
            z.object({ present: z.boolean() }),
            sql`select exists (select 1 from account where is_root) as present`,
        );
        if (!rootRes.ok) return rootRes;
        if (rootRes.value?.present === true) {
            return err({ code: "ROOT_ALREADY_EXISTS" });
        }

        const insertAcc = await execute(
            tx,
            sql`insert into account (id, email, username, is_root, created_at)
                values (${accountId}, ${normalizedEmail}, ${parsedName.value.username}, true, ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!insertAcc.ok) {
            if (insertAcc.error.code === "UNIQUE_VIOLATION") {
                if (insertAcc.error.constraint === "account_single_root_idx") {
                    return err({ code: "ROOT_ALREADY_EXISTS" });
                }
                if (insertAcc.error.constraint === "account_email_key") {
                    return err({ code: "EMAIL_TAKEN" });
                }
                return err({ code: "USERNAME_TAKEN" });
            }
            return insertAcc;
        }

        const claimRes = await execute(
            tx,
            sql`insert into username_claim (skeleton, username, account_id, claimed_at)
                values (${parsedName.value.skeleton}, ${parsedName.value.username}, ${accountId}, ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!claimRes.ok) {
            if (claimRes.error.code === "UNIQUE_VIOLATION") {
                return err({ code: "USERNAME_TAKEN" });
            }
            return claimRes;
        }

        const setupToken = await issueSetupToken(tx, {
            rng: params.rng,
            accountId,
            issuedBy: "cli:bootstrap",
            txNow,
        });
        if (!setupToken.ok) return setupToken;

        const auditRes = await appendAudit(tx, {
            actorId: "cli:bootstrap",
            client: null,
            operation: "account.bootstrap_root",
            target: { accountId },
            at: txNow,
        });
        if (!auditRes.ok) return auditRes;

        return ok({ accountId, setupToken: setupToken.value });
    });
}

const CreateAccountReceiptSchema = z.object({ accountId: AccountId });

// The new account has an email and nothing else: whoever holds the setup link chooses its
// username and credentials. A replay returns the account but no link (receipts never hold a
// secret); `recoverAccount` issues a fresh one.
export async function createAccount(params: {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly email: string;
}): Promise<
    Result<
        | {
              readonly accountId: AccountId;
              readonly setupToken: BearerToken;
              readonly replayed: false;
          }
        | { readonly accountId: AccountId; readonly replayed: true },
        StaffFailure<ReceiptRefusal | Refusal<"EMAIL_TAKEN">>
    >
> {
    const email = params.email.trim().toLowerCase();
    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "accounts.create",
        operationId: params.operationId,
        payload: { email },
    });
    const accountId = newAccountId(params.rng);

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "accounts:create",
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, CreateAccountReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return ok({ accountId: replay.value.result.accountId, replayed: true as const });
        }

        const inserted = await execute(
            tx,
            sql`insert into account (id, email, created_at)
                values (${accountId}, ${email}, ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!inserted.ok) {
            if (inserted.error.code === "UNIQUE_VIOLATION") return err({ code: "EMAIL_TAKEN" });
            return inserted;
        }
        const setupToken = await issueSetupToken(tx, {
            rng: params.rng,
            accountId,
            issuedBy: params.caller.accountId,
            txNow,
        });
        if (!setupToken.ok) return setupToken;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "account.create",
            target: { accountId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        const recorded = await recordReceipt(tx, op, { accountId });
        if (!recorded.ok) return recorded;
        return ok({ accountId, setupToken: setupToken.value, replayed: false as const });
    });
}

// Recovery is staff-driven: every credential and session of the target goes, and a new setup
// link is the only way back in. Not idempotent by design: each call issues a fresh link.
export async function recoverAccount(params: {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly caller: Caller;
    readonly targetAccountId: AccountId;
}): Promise<Result<{ readonly setupToken: BearerToken }, StaffFailure<Refusal<"NOT_FOUND">>>> {
    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "accounts:recover",
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;

        const cleared = await clearCredentials(tx, params.targetAccountId);
        if (!cleared.ok) return cleared;
        const setupToken = await issueSetupToken(tx, {
            rng: params.rng,
            accountId: params.targetAccountId,
            issuedBy: params.caller.accountId,
            txNow,
        });
        if (!setupToken.ok) return setupToken;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "account.recover",
            target: { accountId: params.targetAccountId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ setupToken: setupToken.value });
    });
}

// No caller can target the root account, so its recovery runs from ops, with database access
// standing in for authority.
export async function recoverRootAccount(params: {
    readonly db: Db;
    readonly rng: CryptoRng;
}): Promise<
    Result<{ readonly accountId: AccountId; readonly setupToken: BearerToken }, WriterFailure>
> {
    return await withTx(params.db, async (tx, txNow) => {
        const root = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where is_root for update`,
        );
        if (!root.ok) return root;
        if (root.value === null) return err({ code: "NOT_FOUND" });
        const accountId = root.value.id;
        const cleared = await clearCredentials(tx, accountId);
        if (!cleared.ok) return cleared;
        const setupToken = await issueSetupToken(tx, {
            rng: params.rng,
            accountId,
            issuedBy: "cli:recover-root",
            txNow,
        });
        if (!setupToken.ok) return setupToken;
        const audited = await appendAudit(tx, {
            actorId: "cli:recover-root",
            client: null,
            operation: "account.recover",
            target: { accountId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ accountId, setupToken: setupToken.value });
    });
}

type ChannelRefusal =
    | { readonly code: "UNKNOWN_PRODUCT"; readonly productId: ProductId }
    | {
          readonly code: "UNKNOWN_CHANNEL";
          readonly productId: ProductId;
          readonly channel: ChannelId;
      };

export type ChannelGrantInput = {
    readonly productId: ProductId;
    readonly channels: readonly ChannelId[];
};

function checkChannels(
    catalog: ProductCatalog,
    productId: ProductId,
    channels: readonly ChannelId[],
): Result<void, ChannelRefusal> {
    const product = catalog.get(productId);
    if (product === undefined) {
        return err({ code: "UNKNOWN_PRODUCT", productId });
    }
    for (const channel of channels) {
        if (!product.channels.includes(channel)) {
            return err({ code: "UNKNOWN_CHANNEL", productId, channel });
        }
    }
    return ok(undefined);
}

function toAuditRole(role: {
    readonly name: string;
    readonly rank: number;
    readonly permissions: readonly string[];
    readonly channelGrants: readonly ChannelGrant[];
}): Record<string, unknown> {
    return {
        name: role.name,
        rank: role.rank,
        permissions: role.permissions,
        channelGrants: role.channelGrants,
    };
}

function toAuditBefore(role: StoredRole): Record<string, unknown> {
    return toAuditRole({
        ...role,
        permissions: [...role.permissions, ...role.unknownPermissions].sort(),
    });
}

const RoleReceiptSchema = z.object({
    roleId: RoleId,
});

export async function upsertRole(params: {
    readonly db: Db;
    readonly catalog: ProductCatalog;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly roleId: RoleId;
    readonly name: string;
    readonly rank: number;
    readonly permissions: readonly Action[];
    // "unchanged" keeps what the role has (none for a new one): the slice 1 editor doesn't show
    // channel grants, and saving there must not wipe them.
    readonly channelGrants: readonly ChannelGrantInput[] | "unchanged";
}): Promise<
    Result<
        { readonly roleId: RoleId; readonly replayed: boolean },
        StaffFailure<
            ReceiptRefusal | ChannelRefusal | Refusal<"INVALID_RANK"> | Refusal<"ROLE_NAME_TAKEN">
        >
    >
> {
    if (!Number.isInteger(params.rank) || params.rank < 0 || params.rank > MAX_RANK) {
        return err({ code: "INVALID_RANK" });
    }
    let requestedGrants: ChannelGrant[] | "unchanged" = "unchanged";
    if (params.channelGrants !== "unchanged") {
        const grants: ChannelGrant[] = [];
        for (const grant of params.channelGrants) {
            const checked = checkChannels(params.catalog, grant.productId, grant.channels);
            if (!checked.ok) return checked;
            grants.push({ productId: grant.productId, channels: sortedUnique(grant.channels) });
        }
        requestedGrants = grants;
    }
    const requested = {
        name: params.name,
        rank: params.rank,
        permissions: sortedUnique(params.permissions),
        channelGrants: requestedGrants,
    };

    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "roles.upsert",
        operationId: params.operationId,
        payload: { roleId: params.roleId, ...requested },
    });

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;

        const existing = await lockRole(tx, params.roleId);
        if (!existing.ok) return existing;
        const before = existing.value;
        const after = {
            ...requested,
            channelGrants:
                requested.channelGrants === "unchanged"
                    ? (before?.channelGrants ?? [])
                    : requested.channelGrants,
        };

        // Rewriting a role touches everyone who holds it, so the caller must outrank it both as
        // it stands and as it will stand.
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "roles:manage",
            target: {
                kind: "role",
                rank: before === null ? after.rank : Math.max(before.rank, after.rank),
                permissions: after.permissions,
            },
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, RoleReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return ok({ roleId: replay.value.result.roleId, replayed: true });
        }

        // A plain insert, not an upsert: a role created concurrently by someone else must not be
        // overwritten without the rank check above having seen it.
        const written =
            before === null
                ? await execute(
                      tx,
                      sql`insert into role (id, name, rank, permissions, channel_grants, created_at)
                          values (
                              ${params.roleId},
                              ${after.name},
                              ${after.rank},
                              ${after.permissions},
                              ${JSON.stringify(after.channelGrants)}::jsonb,
                              ${toTimestamptz(txNow)}::timestamptz
                          )`,
                  )
                : await execute(
                      tx,
                      sql`update role set
                              name = ${after.name},
                              rank = ${after.rank},
                              permissions = ${after.permissions},
                              channel_grants = ${JSON.stringify(after.channelGrants)}::jsonb
                          where id = ${params.roleId}`,
                  );
        if (!written.ok) {
            if (
                written.error.code === "UNIQUE_VIOLATION" &&
                written.error.constraint === "role_name_key"
            ) {
                return err({ code: "ROLE_NAME_TAKEN" });
            }
            return written;
        }

        const auditRes = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "role.upsert",
            target: {
                roleId: params.roleId,
                before: before === null ? null : toAuditBefore(before),
                after: toAuditRole(after),
            },
            at: txNow,
        });
        if (!auditRes.ok) return auditRes;

        const recRes = await recordReceipt(tx, op, { roleId: params.roleId });
        if (!recRes.ok) return recRes;

        return ok({ roleId: params.roleId, replayed: false });
    });
}

export async function assignAccountRole(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly targetAccountId: AccountId;
    readonly roleId: RoleId;
    readonly expiresAt: EpochMs | null;
}): Promise<Result<void, StaffFailure<Refusal<"NOT_FOUND">>>> {
    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });

        const role = await readRole(tx, params.roleId);
        if (!role.ok) return role;

        const roleAuthz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "roles:assign",
            target: { kind: "role", rank: role.value.rank, permissions: role.value.permissions },
        });
        if (!roleAuthz.ok) return roleAuthz;

        const accountAuthz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "roles:assign",
            target: { kind: "account", account: target },
        });
        if (!accountAuthz.ok) return accountAuthz;

        const expiresIso = params.expiresAt === null ? null : toTimestamptz(params.expiresAt);
        const ins = await execute(
            tx,
            sql`insert into account_role (account_id, role_id, granted_at, expires_at)
                values (${params.targetAccountId}, ${params.roleId}, ${toTimestamptz(txNow)}::timestamptz, ${expiresIso}::timestamptz)
                on conflict (account_id, role_id) do update set expires_at = excluded.expires_at`,
        );
        if (!ins.ok) return ins;

        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "role.assign",
            target: {
                accountId: params.targetAccountId,
                roleId: params.roleId,
                expiresAt: params.expiresAt,
            },
            at: txNow,
        });
    });
}

export type EntitlementProductInput = {
    readonly productId: ProductId;
    readonly features: FeatureSelection;
    readonly channels: readonly ChannelId[];
};

const EntitlementReceiptSchema = z.object({
    entitlementId: EntitlementId,
});

export async function issueEntitlement(params: {
    readonly db: Db;
    readonly rng: CryptoRng;
    readonly catalog: ProductCatalog;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly targetAccountId: AccountId;
    readonly validFrom: EpochMs;
    readonly validUntil: EpochMs | null;
    readonly products: readonly EntitlementProductInput[];
}): Promise<
    Result<{ readonly entitlementId: EntitlementId; readonly replayed: boolean }, WriterFailure>
> {
    if (params.products.length === 0) {
        return err({ code: "NO_PRODUCTS" });
    }
    if (params.validUntil !== null && params.validUntil <= params.validFrom) {
        return err({ code: "INVALID_WINDOW" });
    }

    const products: EntitlementProductInput[] = [];
    for (const item of params.products) {
        const checked = checkChannels(params.catalog, item.productId, item.channels);
        if (!checked.ok) return checked;
        products.push({
            productId: item.productId,
            features: item.features === "*" ? "*" : sortedUnique(item.features),
            channels: sortedUnique(item.channels),
        });
    }
    products.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "entitlements.issue",
        operationId: params.operationId,
        payload: {
            targetAccountId: params.targetAccountId,
            validFrom: params.validFrom,
            validUntil: params.validUntil,
            products,
        },
    });

    const newId = newEntitlementId(params.rng);

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });

        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "entitlements:issue",
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, EntitlementReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return ok({ entitlementId: replay.value.result.entitlementId, replayed: true });
        }

        const untilIso = params.validUntil === null ? null : toTimestamptz(params.validUntil);
        const insEnt = await execute(
            tx,
            sql`insert into entitlement (id, account_id, status, valid_from, valid_until, created_at)
                values (
                    ${newId},
                    ${params.targetAccountId},
                    'active',
                    ${toTimestamptz(params.validFrom)}::timestamptz,
                    ${untilIso}::timestamptz,
                    ${toTimestamptz(txNow)}::timestamptz
                )`,
        );
        if (!insEnt.ok) return insEnt;

        for (const item of products) {
            const insProd = await execute(
                tx,
                sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
                    values (${newId}, ${item.productId}, ${JSON.stringify(item.features)}::jsonb, ${item.channels})`,
            );
            if (!insProd.ok) return insProd;
        }

        const auditRes = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "entitlement.issue",
            target: {
                accountId: params.targetAccountId,
                entitlementId: newId,
                validFrom: params.validFrom,
                validUntil: params.validUntil,
                products,
            },
            at: txNow,
        });
        if (!auditRes.ok) return auditRes;

        const recRes = await recordReceipt(tx, op, { entitlementId: newId });
        if (!recRes.ok) return recRes;

        return ok({ entitlementId: newId, replayed: false });
    });
}

const SuspendReceiptSchema = z.object({ suspended: z.literal(true) });

export async function suspendAccount(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly targetAccountId: AccountId;
    readonly reason: string;
}): Promise<
    Result<{ readonly replayed: boolean }, StaffFailure<ReceiptRefusal | Refusal<"NOT_FOUND">>>
> {
    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "accounts.suspend",
        operationId: params.operationId,
        payload: {
            targetAccountId: params.targetAccountId,
            reason: params.reason,
        },
    });

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });

        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "accounts:suspend",
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, SuspendReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return ok({ replayed: true });
        }

        const upd = await execute(
            tx,
            sql`update account set status = 'suspended' where id = ${params.targetAccountId}`,
        );
        if (!upd.ok) return upd;

        const auditRes = await appendAudit(tx, {
            actorId: params.caller.accountId,
            client: params.caller.client,
            operation: "account.suspend",
            target: { accountId: params.targetAccountId, reason: params.reason },
            at: txNow,
        });
        if (!auditRes.ok) return auditRes;

        const recRes = await recordReceipt(tx, op, { suspended: true });
        if (!recRes.ok) return recRes;

        return ok({ replayed: false });
    });
}

const ReinstateReceiptSchema = z.object({ reinstated: z.literal(true) });

export async function reinstateAccount(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly targetAccountId: AccountId;
}): Promise<
    Result<{ readonly replayed: boolean }, StaffFailure<ReceiptRefusal | Refusal<"NOT_FOUND">>>
> {
    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "accounts.reinstate",
        operationId: params.operationId,
        payload: { targetAccountId: params.targetAccountId },
    });

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "accounts:reinstate",
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, ReinstateReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) return ok({ replayed: true });

        const upd = await execute(
            tx,
            sql`update account set status = 'active' where id = ${params.targetAccountId}`,
        );
        if (!upd.ok) return upd;
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            operation: "account.reinstate",
            target: { accountId: params.targetAccountId },
            at: txNow,
            client: params.caller.client,
        });
        if (!audited.ok) return audited;
        const recorded = await recordReceipt(tx, op, { reinstated: true });
        if (!recorded.ok) return recorded;
        return ok({ replayed: false });
    });
}

const RenameReceiptSchema = z.object({ username: z.string() });

// A rename claims the new name's skeleton for good, and the old claim stays, so neither name
// (nor a look-alike) can go to anyone else. Reclaiming one of the account's own earlier names is
// allowed: its claim is already theirs.
export async function renameAccount(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly operationId: OperationId;
    readonly targetAccountId: AccountId;
    readonly username: string;
}): Promise<
    Result<
        { readonly username: string; readonly replayed: boolean },
        StaffFailure<
            ReceiptRefusal | UsernameInvalid | Refusal<"NOT_FOUND"> | Refusal<"USERNAME_TAKEN">
        >
    >
> {
    const parsed = parseUsername(params.username);
    if (!parsed.ok) return parsed;
    const { username, skeleton } = parsed.value;
    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "accounts.rename",
        operationId: params.operationId,
        payload: { targetAccountId: params.targetAccountId, username },
    });

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });
        const authz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "accounts:rename",
            target: { kind: "account", account: target },
        });
        if (!authz.ok) return authz;

        const replay = await readReplay(tx, op, RenameReceiptSchema);
        if (!replay.ok) return replay;
        if (replay.value.replayed) {
            return ok({ username: replay.value.result.username, replayed: true });
        }

        const before = await queryOne(
            tx,
            z.object({ username: z.string().nullable() }),
            sql`select username from account where id = ${params.targetAccountId}`,
        );
        if (!before.ok) return before;
        const claim = await queryOne(
            tx,
            z.object({ account_id: AccountId }),
            sql`select account_id from username_claim where skeleton = ${skeleton}`,
        );
        if (!claim.ok) return claim;
        if (claim.value !== null && claim.value.account_id !== params.targetAccountId) {
            return err({ code: "USERNAME_TAKEN" });
        }
        if (claim.value === null) {
            const claimed = await execute(
                tx,
                sql`insert into username_claim (skeleton, username, account_id, claimed_at)
                    values (${skeleton}, ${username}, ${params.targetAccountId},
                            ${toTimestamptz(txNow)}::timestamptz)`,
            );
            if (!claimed.ok) {
                if (claimed.error.code === "UNIQUE_VIOLATION")
                    return err({ code: "USERNAME_TAKEN" });
                return claimed;
            }
        }
        // The database refuses a username change unless the transaction says it's an admin
        // rename (0001's account_username_immutable_trg); `true` scopes the setting to this tx.
        const allowed = await execute(
            tx,
            sql`select set_config('lucent.username_rename', 'on', true)`,
        );
        if (!allowed.ok) return allowed;
        const renamed = await execute(
            tx,
            sql`update account set username = ${username} where id = ${params.targetAccountId}`,
        );
        if (!renamed.ok) {
            if (renamed.error.code === "UNIQUE_VIOLATION") return err({ code: "USERNAME_TAKEN" });
            return renamed;
        }
        const audited = await appendAudit(tx, {
            actorId: params.caller.accountId,
            operation: "account.rename",
            target: {
                accountId: params.targetAccountId,
                from: before.value?.username ?? null,
                to: username,
            },
            at: txNow,
            client: params.caller.client,
        });
        if (!audited.ok) return audited;
        const recorded = await recordReceipt(tx, op, { username });
        if (!recorded.ok) return recorded;
        return ok({ username, replayed: false });
    });
}

// Taking a role away needs the same standing as handing it out. One not held is already gone.
export async function unassignAccountRole(params: {
    readonly db: Db;
    readonly caller: Caller;
    readonly targetAccountId: AccountId;
    readonly roleId: RoleId;
}): Promise<Result<void, StaffFailure<Refusal<"NOT_FOUND">>>> {
    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, {
            caller: params.caller,
            targets: [params.targetAccountId],
            txNow,
        });
        if (!locked.ok) return locked;
        const target = locked.value.accounts.get(params.targetAccountId);
        if (target === undefined) return err({ code: "NOT_FOUND" });
        const role = await readRole(tx, params.roleId);
        if (!role.ok) return role;
        const roleAuthz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "roles:assign",
            target: { kind: "role", rank: role.value.rank, permissions: role.value.permissions },
        });
        if (!roleAuthz.ok) return roleAuthz;
        const accountAuthz = authorize({
            txNow,
            subject: locked.value.subject,
            action: "roles:assign",
            target: { kind: "account", account: target },
        });
        if (!accountAuthz.ok) return accountAuthz;

        const removed = await execute(
            tx,
            sql`delete from account_role
                where account_id = ${params.targetAccountId} and role_id = ${params.roleId}`,
        );
        if (!removed.ok) return removed;
        if (removed.value === 0) return ok(undefined);
        return await appendAudit(tx, {
            actorId: params.caller.accountId,
            operation: "role.unassign",
            target: { accountId: params.targetAccountId, roleId: params.roleId },
            at: txNow,
            client: params.caller.client,
        });
    });
}
