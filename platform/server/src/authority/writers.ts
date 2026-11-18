import { z } from "zod";
import { clearCredentials, issueSetupToken } from "../auth/setup.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { CryptoRng } from "../core/rng.ts";
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
} from "../core/scalars.ts";
import { appendAudit } from "../db/audit.ts";
import { type Db, type DbFailure, execute, queryOne, sql, toTimestamptz } from "../db/pool.ts";
import { type ReceiptRefusal, readReplay, recordReceipt, toOperationKey } from "../db/receipt.ts";
import { withTx } from "../db/tx.ts";
import type { ProductCatalog } from "../products/catalog.ts";
import type { Action } from "./actions.ts";
import type { FeatureSelection } from "./entitlements.ts";
import { type AuthzRefusal, authorize, type Caller } from "./policy.ts";
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
    | { readonly code: "INVALID_WINDOW" };

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
        WriterFailure
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
}): Promise<Result<{ readonly setupToken: BearerToken }, WriterFailure>> {
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
            operation: "account.recover",
            target: { accountId },
            at: txNow,
        });
        if (!audited.ok) return audited;
        return ok({ accountId, setupToken: setupToken.value });
    });
}

export type ChannelGrantInput = {
    readonly productId: ProductId;
    readonly channels: readonly ChannelId[];
};

function checkChannels(
    catalog: ProductCatalog,
    productId: ProductId,
    channels: readonly ChannelId[],
): Result<void, WriterFailure> {
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
    readonly channelGrants: readonly ChannelGrantInput[];
}): Promise<Result<{ readonly roleId: RoleId; readonly replayed: boolean }, WriterFailure>> {
    if (!Number.isInteger(params.rank) || params.rank < 0 || params.rank > MAX_RANK) {
        return err({ code: "INVALID_RANK" });
    }
    const channelGrants: ChannelGrant[] = [];
    for (const grant of params.channelGrants) {
        const checked = checkChannels(params.catalog, grant.productId, grant.channels);
        if (!checked.ok) return checked;
        channelGrants.push({ productId: grant.productId, channels: sortedUnique(grant.channels) });
    }
    const after = {
        name: params.name,
        rank: params.rank,
        permissions: sortedUnique(params.permissions),
        channelGrants,
    };

    const op = await toOperationKey({
        principal: principalOf(params.caller),
        endpoint: "roles.upsert",
        operationId: params.operationId,
        payload: { roleId: params.roleId, ...after },
    });

    return await withTx(params.db, async (tx, txNow) => {
        const locked = await lockCallerWith(tx, { caller: params.caller, targets: [], txNow });
        if (!locked.ok) return locked;

        const existing = await lockRole(tx, params.roleId);
        if (!existing.ok) return existing;
        const before = existing.value;

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
        if (!written.ok) return written;

        const auditRes = await appendAudit(tx, {
            actorId: params.caller.accountId,
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
}): Promise<Result<void, WriterFailure>> {
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
}): Promise<Result<{ readonly replayed: boolean }, WriterFailure>> {
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
