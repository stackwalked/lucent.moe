import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryOne, sql } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import { withMemberAt } from "./member.ts";
import type { NotFound } from "./page.ts";
import { mayPostHere } from "./standing.ts";

export function readProfile(db: Db, token: BearerToken, params: { readonly username: string }) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            z.object({
                id: z.string(),
                username: z.string(),
                bio: z.string(),
                joinedAt: EpochMs,
            }),
            sql`select a.id, a.username, coalesce(p.bio, '') as bio, a.created_at as "joinedAt"
                from account a left join profile p on p.account_id = a.id
                where a.username = ${params.username.toLowerCase()}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const { id, ...profile } = row.value;
        return ok({ ...profile, isSelf: id === accountId });
    });
}

export function setBio(db: Db, token: BearerToken, params: { readonly bio: string }) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const may = await mayPostHere(tx, {
            accountId,
            surface: "profile",
            productId: null,
            txNow,
        });
        if (!may.ok) return may;
        const saved = await execute(
            tx,
            sql`insert into profile (account_id, bio) values (${accountId}, ${params.bio})
                on conflict (account_id) do update set bio = excluded.bio, updated_at = now()`,
        );
        if (!saved.ok) return saved;
        return ok(undefined);
    });
}
