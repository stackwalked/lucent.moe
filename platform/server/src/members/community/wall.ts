import { err, ok } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql, type Tx } from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { lockSession, readSession } from "../../identity/auth/sessions.ts";
import { authorAvatar } from "./avatars.ts";
import { notBlockedWith } from "./blocks.ts";
import { checkPostRate } from "./limits.ts";
import { withMemberAt } from "./member.ts";
import { type NotFound, PAGE_SIZE, pageOf } from "./page.ts";
import { mayPostHere, readMaySeeSuspended } from "./standing.ts";

// A profile's wall: comments that attach to an account instead of a guide. A wall is the owner's
// profile's own, so it is read by the same rule as the profile: a private profile (the owner's
// excepted), a suspended account (to anyone but itself and staff reading accounts), a tombstone
// and a block in either direction are all "no such account". The owner's `show_wall` opt-out
// empties it for everyone else and refuses writing to it; the owner still reads and writes their
// own.
//
// This only reads. A writer takes lockWallParties first and reads after: under READ COMMITTED a
// subquery in a locking statement sees the snapshot from before the lock wait, so a block or a
// privacy switch that committed meanwhile would be missed.
async function wallOwner(
    tx: Tx,
    viewer: { readonly id: AccountId; readonly seesSuspended: boolean },
    username: string,
) {
    const owner = await queryOne(
        tx,
        z.object({ id: AccountId, showWall: z.boolean() }),
        sql`select a.id, coalesce(p.show_wall, true) as "showWall"
            from account a left join profile p on p.account_id = a.id
            where a.username = ${username.toLowerCase()}
              and (a.id = ${viewer.id} or coalesce(p.visibility, 'members') = 'members')
              and (a.status = 'active' or a.id = ${viewer.id} or ${viewer.seesSuspended})
              and ${notBlockedWith(viewer.id, sql`a.id`)}`,
    );
    if (!owner.ok) return owner;
    if (owner.value === null) return err<NotFound>({ code: "NOT_FOUND" });
    return ok({
        id: owner.value.id,
        isSelf: owner.value.id === viewer.id,
        shown: owner.value.showWall,
    });
}

// The writer's account row `for update` and the owner's `for share`, taken in ascending id order
// (the canonical account order, platform/AGENTS.md), so two members writing on each other's walls
// never wait on each other in a cycle. The owner's lock also makes a deletion stripping the
// account (deletion/strip.ts) either wait for a comment being written or find it, and holds off
// the owner's own block, visibility and `show_wall` writers, which lock their row `for update`.
async function lockWallParties(
    tx: Tx,
    parties: { readonly writer: AccountId; readonly owner: AccountId },
) {
    for (const id of [...new Set([parties.writer, parties.owner])].sort()) {
        const locked = await execute(
            tx,
            id === parties.writer
                ? sql`select 1 from account where id = ${id} for update`
                : sql`select 1 from account where id = ${id} for share`,
        );
        if (!locked.ok) return locked;
    }
    return ok(undefined);
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
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const sees = await readMaySeeSuspended(tx, { accountId, txNow });
        if (!sees.ok) return sees;
        const owner = await wallOwner(
            tx,
            { id: accountId, seesSuspended: sees.value },
            params.username,
        );
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
    return withTx(db, async (tx, txNow) => {
        // Not withMemberAt: that locks the writer's row before the owner is known, and the owner
        // may sort before the writer. The session is read unlocked to learn who writes, the rows
        // are locked in id order, then the session is locked (its account row is already ours)
        // and everything the decision rests on is read after.
        const seen = await readSession(tx, { token, txNow, purposes: ["member"] });
        if (!seen.ok) return seen;
        const named = await queryOne(
            tx,
            z.object({ id: AccountId }),
            sql`select id from account where username = ${params.username.toLowerCase()}`,
        );
        if (!named.ok) return named;
        if (named.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const locked = await lockWallParties(tx, {
            writer: seen.value.accountId,
            owner: named.value.id,
        });
        if (!locked.ok) return locked;
        const session = await lockSession(tx, { token, txNow, purposes: ["member"] });
        if (!session.ok) return session;
        const accountId = session.value.accountId;
        const sees = await readMaySeeSuspended(tx, { accountId, txNow });
        if (!sees.ok) return sees;
        const owner = await wallOwner(
            tx,
            { id: accountId, seesSuspended: sees.value },
            params.username,
        );
        if (!owner.ok) return owner;
        if (owner.value.id !== named.value.id) return err<NotFound>({ code: "NOT_FOUND" });
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
