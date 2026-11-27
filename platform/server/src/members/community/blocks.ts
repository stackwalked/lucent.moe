import { err, ok } from "@lucent/core/result";
import type { AccountId, BearerToken } from "@lucent/core/scalars";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, type SqlFragment, sql } from "../../base/db/pool.ts";
import { withMember } from "../notify/account.ts";
import type { NotFound } from "./page.ts";

// Neither side sees the other's writing: a read keeps a row only if no block joins its author and
// the reader, in either direction. `author` is the SQL expression for the row's author.
export function notBlockedWith(viewer: AccountId, author: SqlFragment): SqlFragment {
    return sql`not exists (
        select 1 from account_block b
        where (b.blocker_id = ${viewer} and b.blocked_id = ${author})
           or (b.blocker_id = ${author} and b.blocked_id = ${viewer}))`;
}

export function setBlock(
    db: Db,
    token: BearerToken,
    params: { readonly username: string; readonly blocked: boolean },
) {
    return withMember(db, token, async (tx, accountId) => {
        const target = await queryOne(
            tx,
            z.object({ id: z.string() }),
            sql`select id from account where username = ${params.username.toLowerCase()} and id <> ${accountId}`,
        );
        if (!target.ok) return target;
        if (target.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const written = await execute(
            tx,
            params.blocked
                ? sql`insert into account_block (blocker_id, blocked_id)
                      values (${accountId}, ${target.value.id}) on conflict do nothing`
                : sql`delete from account_block
                      where blocker_id = ${accountId} and blocked_id = ${target.value.id}`,
        );
        if (!written.ok) return written;
        return ok(undefined);
    });
}

// Only the member's own blocks: whether someone has blocked them is not theirs to read.
export function listBlocks(db: Db, token: BearerToken) {
    return withMember(db, token, async (tx, accountId) => {
        const rows = await queryAll(
            tx,
            z.object({ username: z.string().nullable(), createdAt: EpochMs }),
            sql`select a.username, b.created_at as "createdAt"
                from account_block b join account a on a.id = b.blocked_id
                where b.blocker_id = ${accountId} order by b.created_at desc, a.id`,
        );
        if (!rows.ok) return rows;
        return ok({ blocks: rows.value });
    });
}
