import type { ProductCatalog } from "@lucent/catalog/catalog";
import { err, ok, type Result } from "@lucent/core/result";
import { AccountId, EpochMs, ProductId } from "@lucent/core/scalars";
import type { Caller } from "@lucent/policy/policy";
import { z } from "zod";
import {
    type Db,
    type DbFailure,
    type Queryable,
    queryAll,
    queryOne,
    sql,
} from "../../base/db/pool.ts";
import { withTx } from "../../base/db/tx.ts";
import { listReleaseLines } from "../../delivery/releases/promotion.ts";
import { readAccount } from "../../identity/authority/reads.ts";
import { readAsStaff } from "../../identity/authority/staff.ts";

// Staff reads asked from Discord. The asker is the account linked to the Discord user who asked,
// with no step-up (none of these reads takes one), and its standing is read again on every call
// by the same reads the admin pages use: a role revoked on the site takes effect at the next
// call, with nothing cached here. A read is answered only in a channel the rules mark staff.

export type StaffAsk = { readonly userId: string; readonly channelId: string };
type Forbidden = { readonly code: "FORBIDDEN" };

async function staffCaller(q: Queryable, ask: StaffAsk): Promise<Result<Caller | null, DbFailure>> {
    const row = await queryOne(
        q,
        z.object({ account_id: AccountId }),
        sql`select l.account_id from connector_discord_link l
            where l.discord_user_id = ${ask.userId}
              and exists (select 1 from connector_discord_rule r
                          where r.kind = 'staff_channel' and r.discord_id = ${ask.channelId})`,
    );
    if (!row.ok) return row;
    return ok(
        row.value === null
            ? null
            : { accountId: row.value.account_id, stepUpAt: null, client: null },
    );
}

// Unlinked, or asked outside a staff channel, refuses exactly as an account without the Action.
async function askedBy(db: Db, ask: StaffAsk): Promise<Result<Caller, Forbidden | DbFailure>> {
    const caller = await withTx(db, (tx) => staffCaller(tx, ask));
    if (!caller.ok) return caller;
    return caller.value === null ? err({ code: "FORBIDDEN" }) : ok(caller.value);
}

export type WhoTarget =
    | { readonly kind: "member"; readonly userId: string }
    | { readonly kind: "query"; readonly text: string };

async function findTarget(q: Queryable, target: WhoTarget) {
    const byId = AccountId.safeParse(target.kind === "query" ? target.text : "");
    const row = await queryOne(
        q,
        z.object({ id: AccountId }),
        target.kind === "member"
            ? sql`select account_id as id from connector_discord_link
                  where discord_user_id = ${target.userId}`
            : byId.success
              ? sql`select id from account where id = ${byId.data}`
              : sql`select id from account where username = ${target.text.toLowerCase()}`,
    );
    return row.ok ? ok(row.value?.id ?? null) : row;
}

const ExtrasRow = z.object({
    last_session_at: EpochMs.nullable(),
    running: z.boolean().nullable(),
    in_review: z.boolean(),
    discord_user_id: z.string().nullable(),
});

const LicenceRow = z.object({ product_id: ProductId, until: EpochMs.nullable() });

export async function readWho(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly siteOrigin: string;
        readonly ask: StaffAsk;
        readonly target: WhoTarget;
    },
) {
    const caller = await askedBy(db, params.ask);
    if (!caller.ok) return caller;
    // Looked up only once the asker may read accounts: a refusal says nothing of who exists.
    const found = await readAsStaff(db, { caller: caller.value, actions: ["accounts:read"] }, (q) =>
        findTarget(q, params.target),
    );
    if (!found.ok) return found;
    if (found.value === null) return err({ code: "NOT_FOUND" as const });
    const accountId = found.value;
    const detail = await readAccount(db, { caller: caller.value, accountId });
    if (!detail.ok) {
        // readAccount pages nothing: a cursor refusal can't come from it.
        const failure = detail.error;
        return failure.code === "INVALID_CURSOR"
            ? err({ code: "NOT_FOUND" as const })
            : err(failure);
    }
    // A deleted account is nobody to ask about on Discord; the site's account page shows it.
    const status = detail.value.status;
    if (status === "deleted") return err({ code: "NOT_FOUND" as const });
    const more = await readAsStaff(
        db,
        { caller: caller.value, actions: ["accounts:read"] },
        async (q) => {
            const extras = await queryOne(
                q,
                ExtrasRow,
                sql`select s.created_at as last_session_at,
                           s.ended_at is null and s.lease_expires_at > now() as running,
                           exists (select 1 from review_item r
                                   where r.account_id = ${accountId} and r.decided_at is null)
                               as in_review,
                           (select l.discord_user_id from connector_discord_link l
                            where l.account_id = ${accountId}) as discord_user_id
                    from (select 1) one
                    left join lateral (select created_at, ended_at, lease_expires_at
                                       from runtime_session where account_id = ${accountId}
                                       order by created_at desc limit 1) s on true`,
            );
            if (!extras.ok) return extras;
            // Licences running now, per product, with the latest end among them (null: none).
            const licences = await queryAll(
                q,
                LicenceRow,
                sql`select ep.product_id,
                           case when bool_or(e.valid_until is null) then null
                                else max(e.valid_until) end as until
                    from entitlement e join entitlement_product ep on ep.entitlement_id = e.id
                    where e.account_id = ${accountId} and e.status = 'active'
                      and e.valid_from <= now()
                      and (e.valid_until is null or e.valid_until > now())
                    group by ep.product_id order by ep.product_id`,
            );
            if (!licences.ok) return licences;
            return ok({ extras: extras.value, licences: licences.value });
        },
    );
    if (!more.ok) return more;
    const account = detail.value;
    const extras = more.value.extras;
    return ok({
        accountId,
        username: account.username,
        status,
        roles: account.roles,
        licences: more.value.licences.map((row) => ({
            product: params.catalog.get(row.product_id)?.name ?? row.product_id,
            until: row.until,
        })),
        devices: { count: account.devices.length, limit: account.limit },
        lastSeenAt: account.lastSeenAt,
        lastSession:
            extras?.last_session_at === null || extras === null
                ? null
                : { at: extras.last_session_at, running: extras.running === true },
        inReview: extras?.in_review === true,
        discordUserId: extras?.discord_user_id ?? null,
        url: `${params.siteOrigin}/admin/accounts/${accountId}`,
    });
}

const BriefRow = z.object({
    sessions: z.coerce.number().int(),
    starts: z.coerce.number().int(),
    active: z.coerce.number().int(),
    ending: z.coerce.number().int(),
    review: z.coerce.number().int(),
    tickets: z.coerce.number().int(),
});

// The day so far, from the rows the system and queue pages read. "Ending" is a licence that runs
// out within a week and has nothing after it.
export async function readBrief(
    db: Db,
    params: { readonly siteOrigin: string; readonly ask: StaffAsk },
) {
    const caller = await askedBy(db, params.ask);
    if (!caller.ok) return caller;
    const counted = await readAsStaff(db, { caller: caller.value, actions: ["audit:read"] }, (q) =>
        queryOne(
            q,
            BriefRow,
            sql`with running as (
                    select account_id, max(coalesce(valid_until, 'infinity'::timestamptz)) as until
                    from entitlement
                    where status = 'active' and valid_from <= now()
                      and (valid_until is null or valid_until > now())
                    group by account_id)
                select
                    (select count(*) from runtime_session
                     where ended_at is null and lease_expires_at > now()) as sessions,
                    (select count(*) from session_start
                     where created_at > now() - interval '1 day') as starts,
                    (select count(*) from running) as active,
                    (select count(*) from running
                     where until <= now() + interval '7 days') as ending,
                    (select count(*) from review_item where decided_at is null) as review,
                    (select count(*) from ticket where state = 'open') as tickets`,
        ),
    );
    if (!counted.ok) return counted;
    const row = counted.value ?? {
        sessions: 0,
        starts: 0,
        active: 0,
        ending: 0,
        review: 0,
        tickets: 0,
    };
    return ok({
        sessionsRunning: row.sessions,
        startsToday: row.starts,
        licencesActive: row.active,
        licencesEnding: row.ending,
        reviewOpen: row.review,
        ticketsOpen: row.tickets,
        url: `${params.siteOrigin}/admin/system`,
    });
}

export async function readStaffReleases(
    db: Db,
    params: {
        readonly catalog: ProductCatalog;
        readonly siteOrigin: string;
        readonly ask: StaffAsk;
    },
) {
    const caller = await askedBy(db, params.ask);
    if (!caller.ok) return caller;
    const lines = await listReleaseLines(db, { catalog: params.catalog, caller: caller.value });
    if (!lines.ok) return lines;
    return ok({
        lines: lines.value.map((line) => ({
            product: line.name,
            channel: line.channel,
            current: line.current,
        })),
        url: `${params.siteOrigin}/admin/releases`,
    });
}
