import { err, ok } from "@lucent/core/result";
import { type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryOne, sql } from "../db/pool.ts";
import { withMember } from "../notify/account.ts";
import { notBlockedWith } from "./blocks.ts";
import { withMemberAt } from "./member.ts";
import type { NotFound } from "./page.ts";
import { mayPostHere } from "./standing.ts";

export const PROFILE_VISIBILITIES = ["members", "private"] as const;

// Someone who blocked you, whom you blocked, or whose profile is private to them is the same
// answer as no such account.
export function readProfile(db: Db, token: BearerToken, params: { readonly username: string }) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            z.object({
                id: z.string(),
                username: z.string(),
                bio: z.string(),
                visibility: z.enum(PROFILE_VISIBILITIES),
                joinedAt: EpochMs,
            }),
            sql`select a.id, a.username, coalesce(p.bio, '') as bio,
                       coalesce(p.visibility, 'members') as visibility, a.created_at as "joinedAt"
                from account a left join profile p on p.account_id = a.id
                where a.username = ${params.username.toLowerCase()}
                  and (a.id = ${accountId} or coalesce(p.visibility, 'members') = 'members')
                  and ${notBlockedWith(accountId, sql`a.id`)}`,
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

// Hiding a profile is not posting, so a restricted account can still do it.
export function setVisibility(
    db: Db,
    token: BearerToken,
    params: { readonly visibility: (typeof PROFILE_VISIBILITIES)[number] },
) {
    return withMember(db, token, async (tx, accountId) => {
        const saved = await execute(
            tx,
            sql`insert into profile (account_id, bio, visibility) values (${accountId}, '', ${params.visibility})
                on conflict (account_id) do update set visibility = excluded.visibility, updated_at = now()`,
        );
        if (!saved.ok) return saved;
        return ok(undefined);
    });
}
