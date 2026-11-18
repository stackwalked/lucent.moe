import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import { type AccountId, ChannelId, type EpochMs, ProductId, RoleId } from "../core/scalars.ts";
import {
    type DbFailure,
    type Queryable,
    queryAll,
    queryOne,
    sql,
    type Tx,
    toTimestamptz,
} from "../db/pool.ts";
import { type Action, ActionSchema } from "./actions.ts";
import type { AccountStanding, AuthzRefusal, Caller, Subject } from "./policy.ts";

// Stored roles outlive the Action union: a permission dropped from code stays in old rows. It
// grants nothing and is kept apart so an admin can see and clean it up.
function splitPermissions(stored: readonly string[]): {
    readonly known: readonly Action[];
    readonly unknown: readonly string[];
} {
    const known: Action[] = [];
    const unknown: string[] = [];
    for (const raw of stored) {
        const parsed = ActionSchema.safeParse(raw);
        if (parsed.success) {
            known.push(parsed.data);
        } else {
            unknown.push(raw);
        }
    }
    return { known, unknown };
}

const AccountLockRowSchema = z.object({
    status: z.enum(["active", "suspended"]),
    is_root: z.boolean(),
    is_locked: z.boolean(),
});

const HeldRoleRowSchema = z.object({
    rank: z.number().int(),
    permissions: z.array(z.string()),
});

// Locks each account `for update` in ascending id order, so writers locking an overlapping set
// never deadlock; every multi-account lock goes through here so the order stays the same one.
// Roles are read after the account lock: role grants change only under that lock.
async function lockAccountStandings(
    tx: Tx,
    accountIds: readonly AccountId[],
    txNow: EpochMs,
): Promise<Result<ReadonlyMap<AccountId, AccountStanding>, DbFailure>> {
    const ordered = [...new Set(accountIds)].sort();
    const standings = new Map<AccountId, AccountStanding>();
    for (const accountId of ordered) {
        const accountRes = await queryOne(
            tx,
            AccountLockRowSchema,
            sql`select status, is_root, is_locked from account where id = ${accountId} for update`,
        );
        if (!accountRes.ok) return accountRes;
        if (accountRes.value === null) continue;

        const rolesRes = await queryAll(
            tx,
            HeldRoleRowSchema,
            sql`select r.rank, r.permissions
                from account_role ar
                join role r on r.id = ar.role_id
                where ar.account_id = ${accountId}
                  and (ar.expires_at is null or ar.expires_at > ${toTimestamptz(txNow)}::timestamptz)`,
        );
        if (!rolesRes.ok) return rolesRes;

        let maxRank = 0;
        const permissions = new Set<Action>();
        for (const role of rolesRes.value) {
            maxRank = Math.max(maxRank, role.rank);
            for (const permission of splitPermissions(role.permissions).known) {
                permissions.add(permission);
            }
        }
        const account = accountRes.value;
        standings.set(accountId, {
            accountId,
            isRoot: account.is_root,
            isActive: account.status === "active" && !account.is_locked,
            maxRank,
            permissions,
        });
    }
    return ok(standings);
}

export type LockedParties = {
    readonly subject: Subject;
    readonly accounts: ReadonlyMap<AccountId, AccountStanding>;
};

// The caller is locked with the accounts it acts on, which also serializes every writer for the
// caller's receipt principal.
export async function lockCallerWith(
    tx: Tx,
    params: {
        readonly caller: Caller;
        readonly targets: readonly AccountId[];
        readonly txNow: EpochMs;
    },
): Promise<Result<LockedParties, AuthzRefusal | DbFailure>> {
    const locked = await lockAccountStandings(
        tx,
        [params.caller.accountId, ...params.targets],
        params.txNow,
    );
    if (!locked.ok) return locked;
    const standing = locked.value.get(params.caller.accountId);
    if (standing === undefined) {
        return err({ code: "FORBIDDEN" });
    }
    return ok({
        subject: { ...standing, stepUpAt: params.caller.stepUpAt },
        accounts: locked.value,
    });
}

const ChannelGrantSchema = z.object({
    productId: ProductId,
    channels: z.array(ChannelId),
});

export type ChannelGrant = z.infer<typeof ChannelGrantSchema>;

export type StoredRole = {
    readonly id: RoleId;
    readonly name: string;
    readonly rank: number;
    readonly permissions: readonly Action[];
    readonly unknownPermissions: readonly string[];
    readonly channelGrants: readonly ChannelGrant[];
};

const RoleRowSchema = z.object({
    id: RoleId,
    name: z.string(),
    rank: z.number().int(),
    permissions: z.array(z.string()),
    channel_grants: z.array(ChannelGrantSchema),
});

function fromRoleRow(row: z.infer<typeof RoleRowSchema>): StoredRole {
    const permissions = splitPermissions(row.permissions);
    return {
        id: row.id,
        name: row.name,
        rank: row.rank,
        permissions: permissions.known,
        unknownPermissions: permissions.unknown,
        channelGrants: row.channel_grants,
    };
}

export async function readRole(
    q: Queryable,
    roleId: RoleId,
): Promise<Result<StoredRole, { readonly code: "NOT_FOUND" } | DbFailure>> {
    const res = await queryOne(
        q,
        RoleRowSchema,
        sql`select id, name, rank, permissions, channel_grants from role where id = ${roleId}`,
    );
    if (!res.ok) return res;
    if (res.value === null) return err({ code: "NOT_FOUND" });
    return ok(fromRoleRow(res.value));
}

// Absence is normal here: the caller is about to create the role.
export async function lockRole(
    tx: Tx,
    roleId: RoleId,
): Promise<Result<StoredRole | null, DbFailure>> {
    const res = await queryOne(
        tx,
        RoleRowSchema,
        sql`select id, name, rank, permissions, channel_grants from role where id = ${roleId} for update`,
    );
    if (!res.ok) return res;
    return ok(res.value === null ? null : fromRoleRow(res.value));
}
