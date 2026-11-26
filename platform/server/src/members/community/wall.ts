import { err, ok } from "@lucent/core/result";
import { type AccountId, type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql, type Tx } from "../../base/db/pool.ts";
import { withMember } from "../notify/account.ts";
import { authorAvatar } from "./avatars.ts";
import { notBlockedWith } from "./blocks.ts";
import { checkPostRate } from "./limits.ts";
import { withMemberAt } from "./member.ts";
import { type NotFound, PAGE_SIZE, pageOf } from "./page.ts";
import { mayPostHere } from "./standing.ts";

// A profile's wall: comments that attach to an account instead of a guide. A wall is the owner's
// profile's own, so it is read by the same rule as the profile: a private profile (the owner's
// excepted), a tombstone and a block in either direction are all "no such account". The owner's
// `show_wall` opt-out empties it for everyone else and refuses writing to it; the owner still
// reads and writes their own. Writing (`write`) share-locks the owner's account row, so a deletion stripping
// the account (deletion/strip.ts) either waits for a comment being written or finds it.
async function wallOwner(tx: Tx, viewer: AccountId, username: string, mode: "read" | "write") {
    const owner = await queryOne(
        tx,
        z.object({ id: z.string(), showWall: z.boolean() }),
        sql`select a.id, coalesce(p.show_wall, true) as "showWall"
            from account a left join profile p on p.account_id = a.id
            where a.username = ${username.toLowerCase()}
              and (a.id = ${viewer} or coalesce(p.visibility, 'members') = 'members')
              and ${notBlockedWith(viewer, sql`a.id`)}
            ${mode === "write" ? sql`for share of a` : sql``}`,
    );
    if (!owner.ok) return owner;
    if (owner.value === null) return err<NotFound>({ code: "NOT_FOUND" });
    return ok({
        id: owner.value.id,
        isSelf: owner.value.id === viewer,
        shown: owner.value.showWall,
    });
}

const Row = z.object({
    id: z.uuid(),
    username: z.string().nullable(),
    avatar: z.string().nullable(),
    authorId: z.string(),
    body: z.string(),
    createdAt: EpochMs,
});

export function listWall(
    db: Db,
    token: BearerToken,
    params: {
        readonly username: string;
        readonly cursor: string | null;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const owner = await wallOwner(tx, accountId, params.username, "read");
        if (!owner.ok) return owner;
        if (!owner.value.isSelf && !owner.value.shown) {
            return ok({ items: [], nextCursor: null });
        }
        const after =
            params.cursor === null
                ? sql``
                : sql`and (c.created_at, c.id) < (
                      select p.created_at, p.id from comment p
                      where p.id = ${params.cursor}::uuid
                        and p.profile_account_id = ${owner.value.id}
                        and p.removed_at is null and ${notBlockedWith(accountId, sql`p.author_id`)})`;
        const rows = await queryAll(
            tx,
            Row,
            sql`select c.id, a.username,
                       ${authorAvatar(accountId, sql`c.author_id`)} as avatar,
                       c.author_id as "authorId", c.body, c.created_at as "createdAt"
                from comment c join account a on a.id = c.author_id
                where c.profile_account_id = ${owner.value.id} and c.removed_at is null
                  and ${notBlockedWith(accountId, sql`c.author_id`)} ${after}
                order by c.created_at desc, c.id desc limit ${PAGE_SIZE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = pageOf(rows.value);
        return ok({
            items: page.items.map(({ username, avatar, authorId, ...row }) => ({
                ...row,
                author: { username, avatar },
                canDelete: authorId === accountId || owner.value.isSelf,
            })),
            nextCursor: page.nextCursor,
        });
    });
}

export function createWallComment(
    db: Db,
    token: BearerToken,
    params: { readonly username: string; readonly body: string },
) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const owner = await wallOwner(tx, accountId, params.username, "write");
        if (!owner.ok) return owner;
        if (!owner.value.isSelf && !owner.value.shown) return err<NotFound>({ code: "NOT_FOUND" });
        const may = await mayPostHere(tx, {
            accountId,
            surface: "comment",
            productId: null,
            txNow,
        });
        if (!may.ok) return may;
        const rate = await checkPostRate(tx, { accountId, txNow });
        if (!rate.ok) return rate;
        const inserted = await queryOne(
            tx,
            z.object({ id: z.uuid() }),
            sql`insert into comment (profile_account_id, author_id, body)
                values (${owner.value.id}, ${accountId}, ${params.body}) returning id`,
        );
        if (!inserted.ok) return inserted;
        if (inserted.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        return ok(inserted.value);
    });
}

// The comment's author and the wall's owner may delete it, whatever blocks lie between them (an
// owner clears their own wall). Anyone else is told it is not there; so is a guide's comment,
// which is staff's to remove through a report. One already removed stays as it is.
export function deleteWallComment(db: Db, token: BearerToken, params: { readonly id: string }) {
    return withMemberAt(db, token, async (tx, accountId) => {
        const found = await queryOne(
            tx,
            z.object({ authorId: z.string(), ownerId: z.string(), removed: z.boolean() }),
            sql`select author_id as "authorId", profile_account_id as "ownerId",
                       removed_at is not null as removed
                from comment
                where id = ${params.id}::uuid and profile_account_id is not null
                for update`,
        );
        if (!found.ok) return found;
        if (found.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        if (found.value.authorId !== accountId && found.value.ownerId !== accountId) {
            return err<NotFound>({ code: "NOT_FOUND" });
        }
        if (found.value.removed) return ok(undefined);
        const removed = await execute(
            tx,
            sql`update comment set removed_at = now(), removed_by = ${accountId}
                where id = ${params.id}::uuid and removed_at is null`,
        );
        if (!removed.ok) return removed;
        return ok(undefined);
    });
}
