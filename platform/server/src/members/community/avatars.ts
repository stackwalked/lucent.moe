import { err, ok } from "@lucent/core/result";
import type { AccountId, BearerToken } from "@lucent/core/scalars";
import { z } from "zod";
import type { AvatarImages } from "../../base/adapters/image/image.ts";
import {
    type Db,
    execute,
    queryAll,
    queryOne,
    type SqlFragment,
    sql,
    type Tx,
} from "../../base/db/pool.ts";
import { withMember } from "../notify/account.ts";
import { decideSetAvatar } from "./avatars.rules.ts";
import { notBlockedWith } from "./blocks.ts";
import { withMemberAt } from "./member.ts";
import type { NotFound } from "./page.ts";
import { readActiveRestrictions } from "./standing.ts";

// A profile's picture: two WebPs the decoder child made (adapters/image), stored by digest in
// avatar_image and named by the profile row. Lock order for every writer here, after the
// session's account: the profile row, then avatar_image rows. A writer that stops naming an
// image deletes it in the same transaction if no profile names it any more.

export type AvatarDigests = { readonly large: string; readonly small: string };

export function toAvatarDigest(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Whose avatar a member may see is whose profile they may open (profiles.ts readProfile): not
// removed, not private to someone else, and no block between them. `owner` is the SQL for the
// profile's account id.
export function avatarVisible(viewer: AccountId, owner: SqlFragment): SqlFragment {
    return sql`p.removed_at is null and (p.account_id = ${viewer} or p.visibility = 'members')
               and ${notBlockedWith(viewer, owner)}`;
}

// The 64 px digest beside what `author` wrote, or null where the viewer may not see it.
export function authorAvatar(viewer: AccountId, author: SqlFragment): SqlFragment {
    return sql`(select p.avatar_small from profile p
                where p.account_id = ${author} and ${avatarVisible(viewer, sql`p.account_id`)})`;
}

const Locked = z.object({
    removed: z.boolean(),
    large: z.string().nullable(),
    small: z.string().nullable(),
});

function lockProfile(tx: Tx, accountId: AccountId) {
    return queryOne(
        tx,
        Locked,
        sql`select removed_at is not null as removed, avatar_large as large, avatar_small as small
            from profile where account_id = ${accountId} for update`,
    );
}

async function gatherSetAvatar(tx: Tx, accountId: AccountId) {
    const profile = await lockProfile(tx, accountId);
    if (!profile.ok) return profile;
    const restrictions = await readActiveRestrictions(tx, accountId);
    if (!restrictions.ok) return restrictions;
    return ok({
        restrictions: restrictions.value,
        profileRemoved: profile.value?.removed === true,
        previous: [profile.value?.large ?? null, profile.value?.small ?? null].filter(
            (digest) => digest !== null,
        ),
    });
}

// Images in `digests` that no profile names any more are deleted. Each row is locked first, so a
// writer naming the same image waits for this one and then inserts it afresh.
export async function forgetAvatars(tx: Tx, digests: readonly string[]) {
    if (digests.length === 0) return ok(0);
    const locked = await queryAll(
        tx,
        z.object({ digest: z.string() }),
        sql`select digest from avatar_image where digest = any(${digests}::text[])
            order by digest for update`,
    );
    if (!locked.ok) return locked;
    return await execute(
        tx,
        sql`delete from avatar_image i where i.digest = any(${digests}::text[])
            and not exists (select 1 from profile p
                            where p.avatar_large = i.digest or p.avatar_small = i.digest
                               or p.banner = i.digest)`,
    );
}

// Before the upload's bytes are read: whether this member may set an avatar now, and who they
// are (the route's rate limit is per account). The writer decides again under its locks once the
// child has answered.
export function checkAvatarUpload(db: Db, token: BearerToken) {
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const gathered = await gatherSetAvatar(tx, accountId);
        if (!gathered.ok) return gathered;
        const decided = decideSetAvatar({ ...gathered.value, now: txNow });
        if (!decided.ok) return decided;
        return ok({ accountId });
    });
}

export function setAvatar(db: Db, token: BearerToken, images: AvatarImages) {
    const digests: AvatarDigests = {
        large: toAvatarDigest(images.large),
        small: toAvatarDigest(images.small),
    };
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const gathered = await gatherSetAvatar(tx, accountId);
        if (!gathered.ok) return gathered;
        const decided = decideSetAvatar({ ...gathered.value, now: txNow });
        if (!decided.ok) return decided;
        // Every image row this writer touches, new and old, locked in digest order before any
        // other: two members swapping pictures take them in the same order and never deadlock.
        // A new one is written (or, if it exists, locked) by its upsert; an old one by a select.
        const fresh = new Map([
            [digests.large, images.large],
            [digests.small, images.small],
        ]);
        const touched = [...new Set([...fresh.keys(), ...gathered.value.previous])].sort();
        for (const digest of touched) {
            const bytes = fresh.get(digest);
            const locked = await execute(
                tx,
                bytes === undefined
                    ? sql`select 1 from avatar_image where digest = ${digest} for update`
                    : sql`insert into avatar_image (digest, bytes) values (${digest}, ${bytes})
                          on conflict (digest) do update set digest = excluded.digest`,
            );
            if (!locked.ok) return locked;
        }
        const named = await execute(
            tx,
            sql`insert into profile (account_id, bio, avatar_large, avatar_small)
                values (${accountId}, '', ${digests.large}, ${digests.small})
                on conflict (account_id) do update
                set avatar_large = excluded.avatar_large, avatar_small = excluded.avatar_small,
                    updated_at = now()`,
        );
        if (!named.ok) return named;
        const forgotten = await forgetAvatars(
            tx,
            gathered.value.previous.filter((d) => d !== digests.large && d !== digests.small),
        );
        if (!forgotten.ok) return forgotten;
        return ok(digests);
    });
}

// Taking a picture down is not posting, so a restricted account can still do it.
export function clearAvatar(db: Db, token: BearerToken) {
    return withMember(db, token, async (tx, accountId) => {
        const profile = await lockProfile(tx, accountId);
        if (!profile.ok) return profile;
        if (profile.value === null || profile.value.large === null) return ok(undefined);
        const cleared = await execute(
            tx,
            sql`update profile set avatar_large = null, avatar_small = null, updated_at = now()
                where account_id = ${accountId}`,
        );
        if (!cleared.ok) return cleared;
        const forgotten = await forgetAvatars(
            tx,
            [profile.value.large, profile.value.small].filter((digest) => digest !== null),
        );
        if (!forgotten.ok) return forgotten;
        return ok(undefined);
    });
}

// The banner is one image, not a pair; everything else is the avatar's rule.
export function setBanner(db: Db, token: BearerToken, image: Uint8Array) {
    const digest = toAvatarDigest(image);
    return withMemberAt(db, token, async (tx, accountId, txNow) => {
        const gathered = await gatherSetAvatar(tx, accountId);
        if (!gathered.ok) return gathered;
        const decided = decideSetAvatar({ ...gathered.value, now: txNow });
        if (!decided.ok) return decided;
        const previous = await queryOne(
            tx,
            z.object({ banner: z.string().nullable() }),
            sql`select banner from profile where account_id = ${accountId} for update`,
        );
        if (!previous.ok) return previous;
        const old = previous.value?.banner ?? null;
        // The new image and the old one are locked in digest order, as setAvatar does, so a
        // banner swap and an avatar swap that share an image never wait on each other in a cycle.
        for (const touched of [...new Set([digest, ...(old === null ? [] : [old])])].sort()) {
            const locked = await execute(
                tx,
                touched === digest
                    ? sql`insert into avatar_image (digest, bytes) values (${digest}, ${image})
                          on conflict (digest) do update set digest = excluded.digest`
                    : sql`select 1 from avatar_image where digest = ${touched} for update`,
            );
            if (!locked.ok) return locked;
        }
        const named = await execute(
            tx,
            sql`insert into profile (account_id, bio, banner) values (${accountId}, '', ${digest})
                on conflict (account_id) do update set banner = excluded.banner, updated_at = now()`,
        );
        if (!named.ok) return named;
        if (old !== null && old !== digest) {
            const forgotten = await forgetAvatars(tx, [old]);
            if (!forgotten.ok) return forgotten;
        }
        return ok(digest);
    });
}

export function clearBanner(db: Db, token: BearerToken) {
    return withMember(db, token, async (tx, accountId) => {
        const profile = await queryOne(
            tx,
            z.object({ banner: z.string().nullable() }),
            sql`select banner from profile where account_id = ${accountId} for update`,
        );
        if (!profile.ok) return profile;
        const old = profile.value?.banner ?? null;
        if (old === null) return ok(undefined);
        const cleared = await execute(
            tx,
            sql`update profile set banner = null, updated_at = now() where account_id = ${accountId}`,
        );
        if (!cleared.ok) return cleared;
        const forgotten = await forgetAvatars(tx, [old]);
        if (!forgotten.ok) return forgotten;
        return ok(undefined);
    });
}

// Staff removing a profile (moderation/reports.ts) take its picture down with the bio, inside
// the removal's transaction and after it locked the profile row. The removal's audit row covers
// both. The owner can set a new one once a new bio lifts the removal.
export async function clearRemovedAvatar(tx: Tx, profileId: string) {
    const previous = await queryOne(
        tx,
        z.object({
            large: z.string().nullable(),
            small: z.string().nullable(),
            banner: z.string().nullable(),
        }),
        sql`update profile p set avatar_large = null, avatar_small = null, banner = null
            from (select id, avatar_large, avatar_small, banner from profile
                  where id = ${profileId}::uuid for update) old
            where p.id = old.id
              and (old.avatar_large is not null or old.banner is not null)
            returning old.avatar_large as large, old.avatar_small as small, old.banner as banner`,
    );
    if (!previous.ok) return previous;
    if (previous.value === null) return ok(0);
    return await forgetAvatars(
        tx,
        [previous.value.large, previous.value.small, previous.value.banner].filter(
            (digest): digest is string => digest !== null,
        ),
    );
}

// One stored image, only while some profile the member may open names it: a digest that was
// replaced, removed or belongs to a private profile is the same answer as one that never was.
export function readAvatarImage(db: Db, token: BearerToken, params: { readonly digest: string }) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            z.object({ bytes: z.instanceof(Uint8Array) }),
            sql`select i.bytes from avatar_image i
                where i.digest = ${params.digest}
                  and exists (select 1 from profile p
                              where (p.avatar_large = i.digest or p.avatar_small = i.digest
                                     or p.banner = i.digest)
                                and ${avatarVisible(accountId, sql`p.account_id`)})`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        return ok(row.value.bytes);
    });
}
