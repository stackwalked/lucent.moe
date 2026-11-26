import { trySync } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import type { BearerToken } from "@lucent/core/scalars";
import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { type Db, queryAll, queryOne, sql } from "../../base/db/pool.ts";
import { withMember } from "../notify/account.ts";
import { notBlockedWith } from "./blocks.ts";
import { roleLabelRows } from "./profiles.ts";

export const DIRECTORY_PAGE = 50;

const Row = z.object({
    id: z.string(),
    username: z.string(),
    avatar: z.string().nullable(),
    memberNo: z.coerce.number(),
    joinedAt: EpochMs,
    joinKey: z.coerce.number(),
    tagline: z.string(),
    roleName: z.string().nullable(),
    roleColor: z.enum(["pink", "shu", "ok", "wait", "violet", "aqua"]).nullable(),
});

export type DirectorySort = "number" | "newest";

// The cursor is opaque to the caller but not secret: base64url of the sort's keyset (the last
// row's key and id), tagged with the sort so a key of one sort is never applied to the other.
function encodeCursor(sort: DirectorySort, key: number, id: string): string {
    return new TextEncoder()
        .encode(JSON.stringify({ s: sort, k: key, i: id }))
        .toBase64({ alphabet: "base64url", omitPadding: true });
}

function decodeCursor(
    sort: DirectorySort,
    cursor: string,
): { readonly key: number; readonly id: string } | null {
    const parsed = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder().decode(Uint8Array.fromBase64(cursor, { alphabet: "base64url" })),
            ),
        () => null,
    );
    if (!parsed.ok) return null;
    const row = z
        .strictObject({ s: z.string(), k: z.number(), i: z.string() })
        .safeParse(parsed.value);
    if (!row.success || row.data.s !== sort) return null;
    return { key: row.data.k, id: row.data.i };
}

// LIKE's wildcards escaped, so a searcher types what they mean.
function likeEscape(text: string): string {
    return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The members directory: every account the viewer may open a profile of, minus tombstones (no
// username) and suspended accounts. The viewer's own row is included even when their profile is
// private; everyone else's private profile is not. No new index: both sorts lead with a unique
// index (member_no, and username for the prefix), and the account table is bounded by the
// member count.
export function listMembers(
    db: Db,
    token: BearerToken,
    params: {
        readonly sort?: DirectorySort | undefined;
        readonly text?: string | undefined;
        readonly cursor?: string | undefined;
    },
) {
    return withMember(db, token, async (tx, accountId) => {
        const sort = params.sort ?? "number";
        const prefix =
            params.text === undefined ? null : `${likeEscape(params.text.toLowerCase())}%`;
        const visible = sql`a.username is not null and a.status = 'active'
            and (a.id = ${accountId} or coalesce(p.visibility, 'members') = 'members')
            and ${notBlockedWith(accountId, sql`a.id`)}`;
        const matching =
            prefix === null ? visible : sql`${visible} and a.username like ${prefix} escape '\\'`;

        const totalRow = await queryOne(
            tx,
            z.object({ total: z.coerce.number() }),
            sql`select count(*) as total from account a left join profile p on p.account_id = a.id
                where ${matching}`,
        );
        if (!totalRow.ok) return totalRow;

        // A garbled or foreign cursor restarts the listing: it is opaque and ephemeral, never
        // typed, so there is nothing to refuse.
        let paging = sql`true`;
        if (params.cursor !== undefined) {
            const at = decodeCursor(sort, params.cursor);
            if (at !== null) {
                paging =
                    sort === "number"
                        ? sql`(a.member_no, a.id) > (${at.key}, ${at.id})`
                        : sql`(a.created_at, a.id) < (to_timestamp(${at.key} / 1000000.0), ${at.id})`;
            }
        }
        const ordering =
            sort === "number" ? sql`a.member_no asc, a.id asc` : sql`a.created_at desc, a.id desc`;

        const rows = await queryAll(
            tx,
            Row,
            sql`select a.id, a.username, a.member_no as "memberNo", a.created_at as "joinedAt",
                       -- Microseconds, so the keyset cursor loses nothing to EpochMs truncation.
                       extract(epoch from a.created_at) * 1000000 as "joinKey",
                       case when p.removed_at is null then coalesce(p.tagline, '') else '' end as tagline,
                       case when p.removed_at is null then p.avatar_small end as avatar,
                       role.name as "roleName", role.color as "roleColor"
                from account a
                left join profile p on p.account_id = a.id
                left join lateral (
                    select r.name, r.label_color as color ${roleLabelRows(sql`a.id`)}
                ) role on true
                where ${matching} and ${paging}
                order by ${ordering}
                limit ${DIRECTORY_PAGE + 1}`,
        );
        if (!rows.ok) return rows;
        const page = (rows.value ?? []).slice(0, DIRECTORY_PAGE);
        const last = page.at(-1);
        const next =
            (rows.value ?? []).length > DIRECTORY_PAGE && last !== undefined
                ? encodeCursor(sort, sort === "number" ? last.memberNo : last.joinKey, last.id)
                : null;
        return ok({
            items: page.map((row) => ({
                username: row.username,
                avatar: row.avatar,
                memberNo: row.memberNo,
                joinedAt: row.joinedAt,
                tagline: row.tagline,
                role:
                    row.roleName === null || row.roleColor === null
                        ? null
                        : { name: row.roleName, color: row.roleColor },
            })),
            next,
            total: totalRow.value?.total ?? 0,
        });
    });
}
