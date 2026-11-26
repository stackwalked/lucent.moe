import { ok } from "@lucent/core/result";
import { AccountId, BearerToken } from "@lucent/core/scalars";
import { type Caller, can } from "@lucent/policy/policy";
import { z } from "zod";
import { matchCodeOf } from "../../base/core/ids.ts";
import { type Db, type Queryable, queryAll, sql } from "../../base/db/pool.ts";
import { hashToken } from "../auth/tokens.ts";
import { readAs } from "./reads.ts";

// The staff search box. Every kind is an exact or prefix match through an index, and a kind the
// caller may not read is an empty list, not a refusal; a caller who may read none is refused.
export const SEARCH_LIMIT = 5;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MATCH_CODE_MIN = 4;
const CANDIDATES = 50;
const WIRE_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function escapeLike(text: string): string {
    return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// A typed match code (or the start of one) as its Crockford digits, or null when it is not one.
export function matchCodeDigits(text: string): string | null {
    const digits = text.toUpperCase().replace(/[-\s]/g, "");
    if (digits.length < MATCH_CODE_MIN || digits.length > 8) return null;
    return [...digits].every((ch) => CROCKFORD.includes(ch)) ? digits : null;
}

// The device key's thumbprint starts with the match code's bits; the whole base64url characters
// those bits cover are what the index can prefix-match, the rest is checked on the few candidates.
export function thumbprintPrefix(digits: string): string {
    let bits = "";
    for (const ch of digits) bits += CROCKFORD.indexOf(ch).toString(2).padStart(5, "0");
    let prefix = "";
    for (let at = 0; at + 6 <= bits.length; at += 6) {
        prefix += BASE64URL[Number.parseInt(bits.slice(at, at + 6), 2)];
    }
    return prefix;
}

const AccountRow = z.object({ id: AccountId, username: z.string().nullable(), email: z.string() });
const PcRow = z.object({
    hex: z.string(),
    jkt: z.string(),
    accountId: AccountId,
    username: z.string().nullable(),
});
const InviteRow = z.object({ inviterId: AccountId, inviterUsername: z.string().nullable() });
const TicketRow = z.object({
    id: z.uuid(),
    subject: z.string().nullable(),
    accountId: AccountId,
    username: z.string().nullable(),
});

async function searchAccounts(q: Queryable, text: string) {
    const prefix = `${escapeLike(text.toLowerCase())}%`;
    return await queryAll(
        q,
        AccountRow,
        sql`select id, username, email from account
            where deleted_at is null and (username like ${prefix} or email like ${prefix})
            order by username nulls last, id limit ${SEARCH_LIMIT}`,
    );
}

async function searchPcs(q: Queryable, text: string) {
    if (WIRE_ID.test(text.toLowerCase())) {
        return await queryAll(
            q,
            PcRow,
            sql`select encode(d.id, 'hex') as hex, d.jkt, a.id as "accountId", a.username
                from device d join account a on a.id = d.account_id
                where d.id = decode(${text.toLowerCase()}, 'hex') and d.revoked_at is null
                  and a.deleted_at is null limit ${SEARCH_LIMIT}`,
        );
    }
    const digits = matchCodeDigits(text);
    if (digits === null) return ok([]);
    const prefix = `${escapeLike(thumbprintPrefix(digits))}%`;
    const rows = await queryAll(
        q,
        PcRow,
        sql`select encode(d.id, 'hex') as hex, d.jkt, a.id as "accountId", a.username
            from device d join account a on a.id = d.account_id
            where d.jkt like ${prefix} and d.revoked_at is null and a.deleted_at is null
            order by d.jkt limit ${CANDIDATES}`,
    );
    if (!rows.ok) return rows;
    return ok(rows.value.filter((row) => matchCodeOf(row.jkt).replace("-", "").startsWith(digits)));
}

// Invite links hold the token, which is stored only as its digest: an exact match on that, from
// the token or from the pasted link.
async function searchInvites(q: Queryable, text: string) {
    const token = BearerToken.safeParse(text.split("#").at(-1) ?? "");
    if (!token.success) return ok([]);
    return await queryAll(
        q,
        InviteRow,
        sql`select i.inviter_id as "inviterId", a.username as "inviterUsername"
            from invite i join account a on a.id = i.inviter_id
            where i.token_hash = ${await hashToken(token.data)} and a.deleted_at is null
            limit ${SEARCH_LIMIT}`,
    );
}

async function searchTickets(q: Queryable, text: string) {
    const prefix = `${escapeLike(text.toLowerCase())}%`;
    const byId = UUID.test(text.toLowerCase()) ? sql`t.id = ${text.toLowerCase()}::uuid or` : sql``;
    return await queryAll(
        q,
        TicketRow,
        sql`select t.id, t.subject, a.id as "accountId", a.username
            from ticket t join account a on a.id = t.account_id
            where a.deleted_at is null
              and (${byId} (t.subject is not null and lower(t.subject) like ${prefix}))
            order by t.last_activity_at desc, t.id limit ${SEARCH_LIMIT}`,
    );
}

export function searchStaff(db: Db, params: { readonly caller: Caller; readonly text: string }) {
    const text = params.text.trim();
    const allowed = (subject: Parameters<typeof can>[0]) =>
        can(subject, "accounts:read") || can(subject, "tickets:reply");
    return readAs(db, { caller: params.caller, allowed }, async (q, _txNow, subject) => {
        const members = can(subject, "accounts:read");
        const accounts = members ? await searchAccounts(q, text) : ok([]);
        if (!accounts.ok) return accounts;
        const pcs = members ? await searchPcs(q, text) : ok([]);
        if (!pcs.ok) return pcs;
        const invites = members ? await searchInvites(q, text) : ok([]);
        if (!invites.ok) return invites;
        const tickets = can(subject, "tickets:reply") ? await searchTickets(q, text) : ok([]);
        if (!tickets.ok) return tickets;
        return ok({
            accounts: accounts.value,
            pcs: pcs.value.slice(0, SEARCH_LIMIT).map((row) => ({
                id: matchCodeOf(row.jkt),
                accountId: row.accountId,
                username: row.username,
            })),
            invites: invites.value.map((row) => ({ code: text, ...row })),
            tickets: tickets.value,
        });
    });
}
