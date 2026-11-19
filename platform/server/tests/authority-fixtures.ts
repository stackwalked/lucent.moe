import { expect } from "bun:test";
import { z } from "zod";
import type { Caller } from "../src/authority/policy.ts";
import { bootstrapRootAccount } from "../src/authority/writers.ts";
import { invariant } from "../src/core/contain.ts";
import type { SeededRng } from "../src/core/rng.ts";
import { type AccountId, EpochMs, newAccountId, ProductId, RoleId } from "../src/core/scalars.ts";
import {
    type Db,
    execute,
    queryOne,
    type SqlFragment,
    sql,
    toTimestamptz,
} from "../src/db/pool.ts";
import {
    loadProductCatalog,
    type ProductCatalog,
    type ProductDefinition,
} from "../src/products/catalog.ts";

export function catalog(): ProductCatalog {
    const res = loadProductCatalog();
    invariant(res.ok, "product catalog must load");
    return res.value;
}

export function product(id: string): ProductDefinition {
    const found = catalog().get(ProductId.parse(id));
    invariant(found !== undefined, `product ${id} must be in the catalog`);
    return found;
}

export async function dbNow(db: Db): Promise<EpochMs> {
    const res = await queryOne(db, z.object({ now: EpochMs }), sql`select now() as now`);
    invariant(res.ok && res.value !== null, "expected database now()");
    return res.value.now;
}

export async function seedRoot(db: Db, rng: SeededRng): Promise<AccountId> {
    const res = await bootstrapRootAccount({
        db,
        rng,
        email: "root@lucent.test",
        username: "founder",
    });
    invariant(res.ok, `root bootstrap failed: ${JSON.stringify(res)}`);
    return res.value.accountId;
}

export async function seedAccount(db: Db, rng: SeededRng, email: string): Promise<AccountId> {
    const accountId = newAccountId(rng);
    const res = await execute(
        db,
        sql`insert into account (id, email) values (${accountId}, ${email})`,
    );
    expect(res).toEqual({ ok: true, value: 1 });
    return accountId;
}

// Raw rows, so a test can store what the writers would refuse (ranks above the caller, retired
// Action strings).
export async function seedRole(
    db: Db,
    params: { readonly id: string; readonly rank: number; readonly permissions: readonly string[] },
): Promise<RoleId> {
    const roleId = RoleId.parse(params.id);
    const res = await execute(
        db,
        sql`insert into role (id, name, rank, permissions)
            values (${roleId}, ${params.id}, ${params.rank}, ${params.permissions})`,
    );
    expect(res).toEqual({ ok: true, value: 1 });
    return roleId;
}

export async function grantRole(
    db: Db,
    params: {
        readonly accountId: AccountId;
        readonly roleId: RoleId;
        readonly expiresAt?: EpochMs;
    },
): Promise<void> {
    const expiresIso = params.expiresAt === undefined ? null : toTimestamptz(params.expiresAt);
    const res = await execute(
        db,
        sql`insert into account_role (account_id, role_id, expires_at)
            values (${params.accountId}, ${params.roleId}, ${expiresIso}::timestamptz)`,
    );
    expect(res).toEqual({ ok: true, value: 1 });
}

export async function seedStaff(
    db: Db,
    rng: SeededRng,
    params: { readonly email: string; readonly roleId: RoleId },
): Promise<AccountId> {
    const accountId = await seedAccount(db, rng, params.email);
    await grantRole(db, { accountId, roleId: params.roleId });
    return accountId;
}

export async function steppedUp(db: Db, accountId: AccountId): Promise<Caller> {
    return { accountId, stepUpAt: await dbNow(db), client: null };
}

const CountRowSchema = z.object({ count: z.coerce.number() });

// Lets a race test start only once every contender is parked on a row lock, so the race is
// real rather than accidentally sequential.
// Whether `count` sessions came to wait on a lock within two seconds. Bounded well inside bun's
// five-second test timeout: a test that times out is abandoned with its transactions still open in
// the shared cluster, while a false here lets the test end its own work and fail an assertion.
export async function waitForLockWaiters(db: Db, count: number): Promise<boolean> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const res = await queryOne(
            db,
            CountRowSchema,
            sql`select count(*) as count from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'`,
        );
        invariant(res.ok && res.value !== null, "pg_stat_activity must be readable");
        if (res.value.count >= count) return true;
        await Bun.sleep(10);
    }
    return false;
}

export async function scalar<T>(db: Db, schema: z.ZodType<T>, statement: SqlFragment): Promise<T> {
    const res = await queryOne(db, z.object({ value: schema }), statement);
    invariant(res.ok && res.value !== null, "expected one row");
    return res.value.value;
}
