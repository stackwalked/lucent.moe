import { ok, type Result } from "@lucent/core/result";
import { AccountId } from "@lucent/core/scalars";
import { z } from "zod";
import { type DbFailure, queryAll, queryOne, sql, type Tx } from "../db/pool.ts";
import type { StoredPasskey } from "./passkeys.ts";

export type LockedAccount = {
    readonly accountId: AccountId;
    readonly username: string | null;
    readonly isActive: boolean;
};

const AccountRowSchema = z.object({
    username: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    is_locked: z.boolean(),
});

// The first lock any credential writer takes (canonical order: account first).
export async function lockAccount(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<LockedAccount | null, DbFailure>> {
    const row = await queryOne(
        tx,
        AccountRowSchema,
        sql`select username, status, is_locked from account where id = ${accountId} for update`,
    );
    if (!row.ok) return row;
    if (row.value === null) return ok(null);
    return ok({
        accountId,
        username: row.value.username,
        isActive: row.value.status === "active" && !row.value.is_locked,
    });
}

const Bytes = z.instanceof(Uint8Array);

const PasskeyRowSchema = z.object({
    id: Bytes,
    public_key: Bytes,
    sign_count: z.coerce.number().int().nonnegative(),
    transports: z.array(z.string()),
});

export async function readPasskeys(
    tx: Tx,
    accountId: AccountId,
): Promise<Result<readonly StoredPasskey[], DbFailure>> {
    const rows = await queryAll(
        tx,
        PasskeyRowSchema,
        sql`select id, public_key, sign_count, transports from passkey
            where account_id = ${accountId} order by created_at, id`,
    );
    if (!rows.ok) return rows;
    return ok(
        rows.value.map((row) => ({
            id: row.id,
            publicKey: row.public_key,
            signCount: row.sign_count,
            transports: row.transports,
        })),
    );
}

export type OwnedPasskey = StoredPasskey & { readonly accountId: AccountId };

export async function findPasskey(
    tx: Tx,
    id: Uint8Array,
): Promise<Result<OwnedPasskey | null, DbFailure>> {
    const row = await queryOne(
        tx,
        PasskeyRowSchema.extend({ account_id: AccountId }),
        sql`select id, public_key, sign_count, transports, account_id from passkey where id = ${id}`,
    );
    if (!row.ok) return row;
    if (row.value === null) return ok(null);
    return ok({
        id: row.value.id,
        publicKey: row.value.public_key,
        signCount: row.value.sign_count,
        transports: row.value.transports,
        accountId: row.value.account_id,
    });
}
