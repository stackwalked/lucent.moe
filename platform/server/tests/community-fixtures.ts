import { invariant } from "@lucent/core/contain";
import type { SeededRng } from "@lucent/core/rng";
import { type AccountId, type BearerToken, newEntitlementId, RoleId } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import type { Logger } from "../src/base/core/log.ts";
import { type Db, execute, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { mintSession } from "../src/identity/auth/sessions.ts";
import { grantRole, seedAccount, seedRole, steppedUp } from "./authority-fixtures.ts";

export type Member = { readonly id: AccountId; readonly token: BearerToken };

export async function sessionFor(db: Db, rng: SeededRng, id: AccountId): Promise<BearerToken> {
    const session = await withTx(db, (tx, txNow) =>
        mintSession(tx, { accountId: id, rng, client: null, purpose: "member", txNow }),
    );
    invariant(session.ok, "expected a session");
    return session.value.token;
}

export async function member(
    db: Db,
    rng: SeededRng,
    email: string,
    username: string | null = null,
): Promise<Member> {
    const id = await seedAccount(db, rng, email);
    if (username !== null) {
        await execute(db, sql`update account set username = ${username} where id = ${id}`);
    }
    return { id, token: await sessionFor(db, rng, id) };
}

// A moderator holds `moderation:remove` in a role of its own at the given rank.
export async function moderator(
    db: Db,
    rng: SeededRng,
    email: string,
    rank = 5,
): Promise<{ readonly id: AccountId; readonly caller: Caller; readonly token: BearerToken }> {
    const roleId = RoleId.parse(`role_${email.replace(/[^a-z0-9]/g, "_")}`);
    await seedRole(db, { id: roleId, rank, permissions: ["moderation:remove"] });
    const id = await seedAccount(db, rng, email);
    await grantRole(db, { accountId: id, roleId });
    return { id, caller: await steppedUp(db, id), token: await sessionFor(db, rng, id) };
}

// An entitlement that makes a seed product listed for the account.
export async function holdProduct(
    db: Db,
    rng: SeededRng,
    accountId: AccountId,
    productId: string,
): Promise<void> {
    const id = newEntitlementId(rng);
    await execute(
        db,
        sql`insert into entitlement (id, account_id, valid_from) values (${id}, ${accountId}, now())`,
    );
    await execute(
        db,
        sql`insert into entitlement_product (entitlement_id, product_id, features, channels)
            values (${id}, ${productId}, '"*"'::jsonb, '{stable}')`,
    );
}

// For tests that mount the web procedures and do not read their log.
export const NO_LOG: Logger = { write: () => {} };
