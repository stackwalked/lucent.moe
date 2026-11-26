import { err, ok } from "@lucent/core/result";
import { AccountId, type BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, execute, queryAll, queryOne, sql, sqlIdent } from "../../base/db/pool.ts";
import { withMember } from "../notify/account.ts";
import { notBlockedWith } from "./blocks.ts";
import { withMemberAt } from "./member.ts";
import type { NotFound } from "./page.ts";
import { mayPostHere } from "./standing.ts";

export const PROFILE_VISIBILITIES = ["members", "private"] as const;

export const SHOW_KEYS = [
    "invitedBy",
    "invited",
    "products",
    "lastSeen",
    "discord",
    "wall",
] as const;
export type ShowKey = (typeof SHOW_KEYS)[number];

const SHOW_COLUMN: Record<ShowKey, string> = {
    invitedBy: "show_invited_by",
    invited: "show_invited",
    products: "show_products",
    lastSeen: "show_last_seen",
    discord: "show_discord",
    wall: "show_wall",
};

// The day a session was last seen, as the start of its UTC day: a profile says which day,
// never a time of day. `lastSeen` is that day's start as EpochMs.
function startOfUtcDay(at: number): number {
    return Math.floor(at / 86_400_000) * 86_400_000;
}

const LOADER_PRODUCT = "lucent-loader";

const BaseRow = z.object({
    id: AccountId,
    profileId: z.uuid().nullable(),
    username: z.string(),
    bio: z.string(),
    visibility: z.enum(PROFILE_VISIBILITIES),
    joinedAt: EpochMs,
    memberNo: z.coerce.number(),
    tagline: z.string(),
    banner: z.string().nullable(),
    avatar: z.object({ large: z.string(), small: z.string() }).nullable(),
    shows: z.object({
        invitedBy: z.boolean(),
        invited: z.boolean(),
        products: z.boolean(),
        lastSeen: z.boolean(),
        discord: z.boolean(),
    }),
});

// Someone who blocked you, whom you blocked, or whose profile is private to them is the same
// answer as no such account. The opt-outs hide their fact from other viewers only: the owner
// always reads their own.
export function readProfile(
    db: Db,
    token: BearerToken,
    params: {
        readonly username: string;
        // Live presence is in-process (community/events.ts), so the hub answers it.
        readonly present?: (accountId: AccountId) => boolean;
        // Product names come from the catalog, which the database does not hold.
        readonly productName?: (productId: string) => string | null;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            BaseRow,
            sql`select a.id, p.id as "profileId", a.username, a.member_no as "memberNo",
                       case when p.removed_at is null then coalesce(p.bio, '') else '' end as bio,
                       case when p.removed_at is null then coalesce(p.tagline, '') else '' end as tagline,
                       case when p.removed_at is null then p.banner end as banner,
                       case when p.removed_at is null and p.avatar_large is not null
                            then json_build_object('large', p.avatar_large, 'small', p.avatar_small)
                       end as avatar,
                       coalesce(p.visibility, 'members') as visibility, a.created_at as "joinedAt",
                       json_build_object(
                           'invitedBy', coalesce(p.show_invited_by, true),
                           'invited', coalesce(p.show_invited, true),
                           'products', coalesce(p.show_products, true),
                           'lastSeen', coalesce(p.show_last_seen, true),
                           'discord', coalesce(p.show_discord, true)) as shows
                from account a left join profile p on p.account_id = a.id
                where a.username = ${params.username.toLowerCase()}
                  and (a.id = ${accountId} or coalesce(p.visibility, 'members') = 'members')
                  and ${notBlockedWith(accountId, sql`a.id`)}`,
        );
        if (!row.ok) return row;
        if (row.value === null) return err<NotFound>({ code: "NOT_FOUND" });
        const { id, profileId, shows, ...base } = row.value;
        const isSelf = id === accountId;
        const shown = (key: keyof typeof shows) => isSelf || shows[key];
        const ownerId = id;

        // The role label: the account's first role (by rank, the roles' order) that carries a
        // colour; an expired assignment is none. Nothing here reads permissions.
        const roleRow = await queryOne(
            tx,
            z.object({
                name: z.string(),
                color: z.enum(["pink", "shu", "ok", "wait", "violet", "aqua"]),
            }),
            sql`select r.name, r.label_color as color
                from account_role ar join role r on r.id = ar.role_id
                where ar.account_id = ${ownerId} and r.label_color is not null
                  and (ar.expires_at is null or ar.expires_at > now())
                order by r.rank asc, r.name asc limit 1`,
        );
        if (!roleRow.ok) return roleRow;

        let invitedBy: string | null = null;
        if (shown("invitedBy")) {
            const inviter = await queryOne(
                tx,
                z.object({ username: z.string().nullable() }),
                // A tombstone has no username, so it never appears.
                sql`select i2.username from invite i
                    join account i2 on i2.id = i.inviter_id
                    where i.invitee_id = ${ownerId} and i2.username is not null`,
            );
            if (!inviter.ok) return inviter;
            invitedBy = inviter.value?.username ?? null;
        }

        let invited: readonly string[] | null = null;
        if (shown("invited")) {
            const rows = await queryAll(
                tx,
                z.object({ username: z.string() }),
                sql`select a.username from invite i join account a on a.id = i.invitee_id
                    where i.inviter_id = ${ownerId} and a.username is not null
                    order by i.redeemed_at asc, i.id asc limit 50`,
            );
            if (!rows.ok) return rows;
            invited = (rows.value ?? []).map((r) => r.username);
        }

        let products: readonly string[] | null = null;
        if (shown("products")) {
            const rows = await queryAll(
                tx,
                z.object({ productId: z.string() }),
                // The same active test readEffectiveProductAccess applies: status, and the
                // window against the transaction's clock.
                sql`select distinct ep.product_id as "productId"
                    from entitlement e join entitlement_product ep on ep.entitlement_id = e.id
                    where e.account_id = ${ownerId} and e.status = 'active'
                      and e.valid_from <= now() and (e.valid_until is null or e.valid_until > now())
                      and ep.product_id <> ${LOADER_PRODUCT}
                    order by ep.product_id`,
            );
            if (!rows.ok) return rows;
            products = (rows.value ?? [])
                .map((r) => (params.productName ?? (() => null))(r.productId))
                .filter((name): name is string => name !== null);
        }

        let lastSeen: "now" | z.output<typeof EpochMs> | null = null;
        if (shown("lastSeen")) {
            if ((params.present ?? (() => false))(ownerId)) {
                lastSeen = "now";
            } else {
                // browser_session.last_seen_at, refreshed as the session resolves: the day of
                // its last session, as that UTC day's start.
                const seen = await queryOne(
                    tx,
                    z.object({ at: EpochMs.nullable() }),
                    sql`select max(last_seen_at) as at from browser_session where account_id = ${ownerId}`,
                );
                if (!seen.ok) return seen;
                lastSeen =
                    seen.value?.at == null ? null : EpochMs.parse(startOfUtcDay(seen.value.at));
            }
        }

        let discord: string | null = null;
        if (shown("discord")) {
            const link = await queryOne(
                tx,
                z.object({ username: z.string().nullable() }),
                sql`select username from connector_discord_link where account_id = ${ownerId}`,
            );
            if (!link.ok) return link;
            discord = link.value?.username ?? null;
        }

        return ok({
            ...base,
            id: profileId,
            isSelf,
            role: roleRow.value ?? null,
            invitedBy,
            invited,
            products,
            lastSeen,
            discord,
        });
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
                on conflict (account_id) do update
                set bio = excluded.bio, updated_at = now(), removed_at = null, removed_by = null`,
        );
        if (!saved.ok) return saved;
        return ok(undefined);
    });
}

// Same rule and restrictions as the bio: it is the profile's text beside it.
export function setTagline(db: Db, token: BearerToken, params: { readonly tagline: string }) {
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
            sql`insert into profile (account_id, bio, tagline) values (${accountId}, '', ${params.tagline})
                on conflict (account_id) do update
                set tagline = excluded.tagline, updated_at = now(), removed_at = null, removed_by = null`,
        );
        if (!saved.ok) return saved;
        return ok(undefined);
    });
}

// Hiding a profile is not posting, so a restricted account can still do it. The opt-outs are
// the same: what others see, never a post.
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

export function readShows(db: Db, token: BearerToken) {
    return withMember(db, token, async (tx, accountId) => {
        const row = await queryOne(
            tx,
            z.object({
                invitedBy: z.boolean(),
                invited: z.boolean(),
                products: z.boolean(),
                lastSeen: z.boolean(),
                discord: z.boolean(),
                wall: z.boolean(),
            }),
            sql`select show_invited_by as "invitedBy", show_invited as invited,
                       show_products as products, show_last_seen as "lastSeen",
                       show_discord as discord, show_wall as wall
                from profile where account_id = ${accountId}`,
        );
        if (!row.ok) return row;
        // No profile row yet: everything is shown, the defaults the columns carry.
        return ok(
            row.value ?? {
                invitedBy: true,
                invited: true,
                products: true,
                lastSeen: true,
                discord: true,
                wall: true,
            },
        );
    });
}

export function setShows(
    db: Db,
    token: BearerToken,
    params: { readonly [K in ShowKey]?: boolean | undefined },
) {
    return withMember(db, token, async (tx, accountId) => {
        const keys = SHOW_KEYS.filter((key) => params[key] !== undefined);
        if (keys.length === 0) return ok(undefined);
        const upsert = await execute(
            tx,
            sql`insert into profile (account_id, bio) values (${accountId}, '')
                on conflict (account_id) do nothing`,
        );
        if (!upsert.ok) return upsert;
        for (const key of keys) {
            const saved = await execute(
                tx,
                sql`update profile set ${sqlIdent(SHOW_COLUMN[key])} = ${params[key] === true},
                       updated_at = now()
                    where account_id = ${accountId}`,
            );
            if (!saved.ok) return saved;
        }
        return ok(undefined);
    });
}
