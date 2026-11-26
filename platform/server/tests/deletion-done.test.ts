import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng, type SeededRng } from "@lucent/core/rng";
import { type AccountId, newOperationId, ProductId, sha256Base64Url } from "@lucent/core/scalars";
import { z } from "zod";
import { listApplications, submitApplication } from "../src/admission/applications.ts";
import {
    createInvite,
    readInviteStanding,
    redeemInvite,
    setInviteAllowance,
} from "../src/admission/invites.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { mintSession } from "../src/auth/sessions.ts";
import { suspendAccount } from "../src/authority/writers.ts";
import { type Db, execute, queryAll, queryOne, sql, sqlIdent } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { requestDeletion } from "../src/deletion/deletion.ts";
import { completeDeletion } from "../src/deletion/strip.ts";
import { sweepRetention } from "../src/jobs/retention.ts";
import { newMember, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, scalar, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

type World = {
    readonly deps: AuthDeps;
    readonly db: Db;
    readonly rng: SeededRng;
    readonly rootId: AccountId;
};

function inWorld(seed: number, run: (world: World) => Promise<void>) {
    return async () => {
        await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
            const rng = createSeededRng(seed);
            const deps = await createTestAuthDeps(db, rng);
            await run({ deps, db, rng, rootId: await seedRootOnce(db, rng) });
        });
    };
}

const LOADER = ProductId.parse("lucent-loader");

const count = (db: Db, statement: ReturnType<typeof sql>) =>
    scalar(db, z.coerce.number(), statement);

async function lapse(db: Db, accountId: AccountId) {
    const moved = await execute(
        db,
        sql`update account set deletion_requested_at = now() - interval '8 days',
                deletion_due_at = now() - interval '1 day'
            where id = ${accountId}`,
    );
    expect(moved).toEqual(ok(1));
}

async function seed(db: Db, statement: ReturnType<typeof sql>) {
    const done = await execute(db, statement);
    invariant(done.ok, `seeding failed: ${JSON.stringify(done)}`);
}

// Every column of every table, cast to text and searched for each marker: which column holds
// which marker. Byte columns are also searched for every marker's bytes.
async function holders(
    db: Db,
    markers: { readonly text: readonly string[]; readonly bytes: readonly Uint8Array[] },
) {
    const columns = await queryAll(
        db,
        z.object({ table_name: z.string(), column_name: z.string(), data_type: z.string() }),
        sql`select c.table_name, c.column_name, c.data_type
            from information_schema.columns c
            join information_schema.tables t
              on t.table_schema = c.table_schema and t.table_name = c.table_name
            where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
            order by 1, 2`,
    );
    invariant(columns.ok, "the catalog reads");
    const encoder = new TextEncoder();
    const asBytes = [...markers.text.map((text) => encoder.encode(text)), ...markers.bytes];
    const found: string[] = [];
    for (const { table_name: table, column_name: column, data_type: type } of columns.value) {
        const hits = await queryAll(
            db,
            z.object({ marker: z.string() }),
            type === "bytea"
                ? sql`select distinct encode(m, 'escape') as marker
                      from ${sqlIdent(table)} x, unnest(${asBytes}::bytea[]) m
                      where position(m in x.${sqlIdent(column)}) > 0`
                : sql`select distinct m as marker
                      from ${sqlIdent(table)} x, unnest(${markers.text}::text[]) m
                      where position(m in x.${sqlIdent(column)}::text) > 0`,
        );
        invariant(hits.ok, `searching ${table}.${column} failed: ${JSON.stringify(hits)}`);
        for (const hit of hits.value) found.push(`${table}.${column}: ${hit.marker}`);
    }
    return found.sort();
}

test(
    "a completed deletion leaves no row holding anything the member wrote, and their ticket text goes 30 days on",
    inWorld(1501, async ({ deps, db, rng }) => {
        const zed = await newMember(deps, rng, { username: "qzvex", with: "all" });
        const obo = await newMember(deps, rng, { username: "obo", with: "passkey" });
        const id = zed.accountId;
        const avatar = "a".repeat(64);
        await seed(
            db,
            sql`insert into avatar_image (digest, bytes) values (${avatar}, ${new TextEncoder().encode("AVATAR-BYTES-7731")})`,
        );
        await seed(
            db,
            sql`insert into profile (account_id, bio, avatar_large, avatar_small)
                values (${id}, 'BIO-MARK-7731', ${avatar}, ${avatar})`,
        );
        await seed(
            db,
            sql`with mine as (
                    insert into guide (product_id, author_id, title, body)
                    values (${LOADER}, ${id}, 'GUIDE-TITLE-7731', 'GUIDE-BODY-7731') returning id),
                theirs as (
                    insert into guide (product_id, author_id, title, body)
                    values (${LOADER}, ${obo.accountId}, 'their guide', 'their body') returning id)
                insert into comment (guide_id, author_id, body)
                select mine.id, ${id}, 'COMMENT-OWN-7731' from mine
                union all select mine.id, ${obo.accountId}, 'COMMENT-OTHER-7731' from mine
                union all select theirs.id, ${id}, 'COMMENT-ELSEWHERE-7731' from theirs`,
        );
        await seed(db, sql`insert into shout (author_id, body) values (${id}, 'SHOUT-7731')`);
        await seed(
            db,
            sql`insert into report (reporter_id, target_kind, target_id, reason, note)
                select ${id}, 'guide', g.id, 'other', 'REPORT-NOTE-7731'
                from guide g where g.author_id = ${obo.accountId}`,
        );
        await seed(
            db,
            sql`insert into account_block (blocker_id, blocked_id) values (${id}, ${obo.accountId})`,
        );
        await seed(
            db,
            sql`with t as (
                    insert into ticket (account_id, kind, subject, state, opened_at, last_activity_at)
                    values (${id}, 'help', 'TICKET-SUBJECT-7731', 'open', now(), now())
                    returning id)
                insert into ticket_message (ticket_id, author_id, from_staff, body, created_at)
                select t.id, ${id}, false, 'TICKET-BODY-7731', now() from t`,
        );
        await seed(
            db,
            sql`insert into cloud_scope (account_id, product_id) values (${id}, ${LOADER})`,
        );
        await seed(
            db,
            sql`with item as (
                    insert into cloud_item (account_id, product_id, kind)
                    values (${id}, ${LOADER}, 'config') returning item_id)
                insert into cloud_version (account_id, product_id, item_id, revision, name, bytes)
                select ${id}, ${LOADER}, item.item_id, 1, 'CLOUD-NAME-7731',
                       ${new TextEncoder().encode("CLOUD-BYTES-7731")} from item`,
        );
        await seed(
            db,
            sql`insert into application (email, products, about, discord, known_by, state,
                                         created_at, decided_at, decided_by, account_id)
                values ('qzvex@lucent.test', ${[LOADER]}, 'APPLY-ABOUT-7731', 'discord-handle-7731',
                        null, 'approved', now(), now(), ${obo.accountId}, ${id})`,
        );
        await seed(
            db,
            sql`insert into connector_discord_link (account_id, discord_user_id, linked_at)
                values (${id}, '123456789012345678', now())`,
        );
        // Two other applicants name the member as who knows them, one as a look-alike.
        await seed(
            db,
            sql`insert into application (email, products, about, known_by, created_at)
                values ('friend1@lucent.test', ${[LOADER]}, 'hi', '@qzvex', now()),
                       ('friend2@lucent.test', ${[LOADER]}, 'hi', 'Qz_Vex', now())`,
        );
        await seed(
            db,
            sql`insert into device (id, account_id, jkt, public_key, storage, enrolled_at, name)
                values (${new Uint8Array(16).fill(7)}, ${id}, 'jkt-7731', '{}', 'software', now(),
                        'DEVICE-NAME-7731')`,
        );
        const markers = {
            text: [
                "qzvex",
                "BIO-MARK-7731",
                "GUIDE-TITLE-7731",
                "GUIDE-BODY-7731",
                "COMMENT-OWN-7731",
                "COMMENT-OTHER-7731",
                "COMMENT-ELSEWHERE-7731",
                "SHOUT-7731",
                "REPORT-NOTE-7731",
                "TICKET-SUBJECT-7731",
                "TICKET-BODY-7731",
                "CLOUD-NAME-7731",
                "APPLY-ABOUT-7731",
                "discord-handle-7731",
                "DEVICE-NAME-7731",
            ],
            bytes: [
                new TextEncoder().encode("AVATAR-BYTES-7731"),
                new TextEncoder().encode("CLOUD-BYTES-7731"),
            ],
        };
        // The seeding reached every place the search looks.
        const before = await holders(db, markers);
        for (const marker of [...markers.text, "AVATAR-BYTES-7731", "CLOUD-BYTES-7731"]) {
            expect(before.some((hit) => hit.endsWith(`: ${marker}`))).toBe(true);
        }

        // Staff made the account by typing its address: the create receipt is keyed on a digest of
        // it (db/receipt.ts), which anyone holding the address could recompute.
        const addressDigest = await sha256Base64Url(JSON.stringify({ email: "qzvex@lucent.test" }));
        const receipts = sql`select count(*) as value from receipt where digest = ${addressDigest}`;
        expect(await count(db, receipts)).toBe(1);

        const asked = await requestDeletion(deps, {
            token: zed.sessionToken,
            purpose: "member",
            client: { ip: "203.0.113.77", userAgent: "UA-MARK-7731" },
        });
        invariant(asked.ok, "requesting failed");
        await lapse(db, id);
        expect((await completeDeletion(deps, id)).ok).toBe(true);
        expect(await count(db, receipts)).toBe(0);
        expect(
            await count(
                db,
                sql`select count(*) as value from application where known_by is not null`,
            ),
        ).toBe(0);

        // What stays by decision, each named: left for the human to decide, not found by omission.
        const kept = {
            text: [...markers.text, "203.0.113.77", "UA-MARK-7731", "123456789012345678"],
            bytes: markers.bytes,
        };
        const decided = [
            // The member's own audit rows keep where the request came from, as every audit row does.
            "audit.client_ip: 203.0.113.77",
            "audit.user_agent: UA-MARK-7731",
            // The unlink row names the Discord user, which is what the connector strips roles from.
            "audit.target: 123456789012345678",
        ];
        // Only the member's own ticket text, kept for support's 30 days, and the decided rows.
        expect(await holders(db, kept)).toEqual(
            [
                ...decided,
                "ticket.subject: TICKET-SUBJECT-7731",
                "ticket_message.body: TICKET-BODY-7731",
            ].sort(),
        );
        await seed(
            db,
            sql`update account set deleted_at = now() - interval '31 days' where id = ${id}`,
        );
        expect((await sweepRetention(db)).ok).toBe(true);
        expect(await holders(db, kept)).toEqual([...decided].sort());
    }),
);

test(
    "a suspended account that deletes is recognised applying again, and kept from coming back by invite",
    inWorld(1502, async ({ deps, db, rng, rootId }) => {
        const sam = await newMember(deps, rng, { username: "sam", with: "passkey" });
        const ida = await newMember(deps, rng, { username: "ida", with: "passkey" });
        const staff = await steppedUp(db, rootId);
        const suspended = await suspendAccount({
            db,
            caller: staff,
            operationId: newOperationId(rng),
            targetAccountId: sam.accountId,
            reason: "cheating",
        });
        expect(suspended.ok).toBe(true);
        // The suspended member deletes from the appeal session their sign-in gives them.
        const appeal = await withTx(db, (tx, txNow) =>
            mintSession(tx, {
                rng,
                accountId: sam.accountId,
                purpose: "appeal",
                txNow,
                client: null,
            }),
        );
        invariant(appeal.ok, "an appeal session");
        expect(
            (
                await requestDeletion(deps, {
                    token: appeal.value.token,
                    purpose: "appeal",
                    client: null,
                })
            ).ok,
        ).toBe(true);
        // Ida, never suspended, deletes as well.
        expect(
            (
                await requestDeletion(deps, {
                    token: ida.sessionToken,
                    purpose: "member",
                    client: null,
                })
            ).ok,
        ).toBe(true);
        for (const member of [sam, ida]) {
            await lapse(db, member.accountId);
            expect((await completeDeletion(deps, member.accountId)).ok).toBe(true);
        }

        // The tombstone keeps a keyed hash, not the address, and only for the suspended one.
        const kept = await queryOne(
            db,
            z.object({ sam: z.boolean(), ida: z.boolean() }),
            sql`select (select email_hash is not null from account where id = ${sam.accountId}) as sam,
                       (select email_hash is not null from account where id = ${ida.accountId}) as ida`,
        );
        expect(kept).toEqual(ok({ sam: true, ida: false }));

        const form = (email: string) => ({
            email,
            products: [LOADER],
            about: "back again",
            discord: null,
            knownBy: null,
        });
        // The applicant hears the same either way.
        for (const email of ["Sam@lucent.test", "ida@lucent.test", "new@lucent.test"]) {
            expect(
                await submitApplication(deps, { catalog: catalog(), input: form(email) }),
            ).toEqual(ok(undefined));
        }
        const queue = await listApplications(db, { caller: staff, state: "pending" });
        invariant(queue.ok, "the queue reads");
        expect(
            queue.value.items.map((item) => [
                item.email,
                item.returningAccountId,
                item.emailHasAccount,
            ]),
        ).toEqual([
            ["sam@lucent.test", sam.accountId, false],
            ["ida@lucent.test", null, false],
            ["new@lucent.test", null, false],
        ]);

        // An invite naming the address answers as for a taken one: no account, and staff see why.
        const inviter = await newMember(deps, rng, { username: "ivy", with: "passkey" });
        expect(
            await setInviteAllowance(db, {
                caller: staff,
                accountId: inviter.accountId,
                granted: 1,
            }),
        ).toEqual(ok(undefined));
        const invite = await createInvite(deps, inviter.sessionToken);
        invariant(invite.ok, "an invite");
        expect(
            await redeemInvite(deps, {
                token: invite.value.token,
                email: "sam@lucent.test",
                client: null,
            }),
        ).toEqual(ok(undefined));
        expect(
            await scalar(
                db,
                z.coerce.number(),
                sql`select count(*) as value from account where email = 'sam@lucent.test'`,
            ),
        ).toBe(0);
        expect(
            await scalar(
                db,
                z.coerce.number(),
                sql`select count(*) as value from audit where operation = 'invite.returning_held'
                    and target ->> 'accountId' = ${sam.accountId}
                    and target ->> 'inviterId' = ${inviter.accountId}
                    and actor_id = 'invite:' || ${invite.value.inviteId}
                    and client_ip is null and user_agent is null`,
            ),
        ).toBe(1);
    }),
);

test(
    "a deleted account's audit rows, invite edges and strike count stay as they were",
    inWorld(1503, async ({ deps, db, rng, rootId }) => {
        const staff = await steppedUp(db, rootId);
        const ivy = await newMember(deps, rng, { username: "ivy", with: "passkey" });
        const moe = await newMember(deps, rng, { username: "moe", with: "passkey" });
        expect(
            await setInviteAllowance(db, { caller: staff, accountId: ivy.accountId, granted: 3 }),
        ).toEqual(ok(undefined));
        // Ivy's invite is Moe's way in: the edge as a redeem leaves it.
        const used = await createInvite(deps, ivy.sessionToken);
        invariant(used.ok, "an invite");
        await seed(
            db,
            sql`update invite set redeemed_at = now(), invitee_id = ${moe.accountId}, token_hash = null
                where id = ${used.value.inviteId}::bigint`,
        );
        // Moe invited someone too, and has one still open.
        expect(
            await setInviteAllowance(db, { caller: staff, accountId: moe.accountId, granted: 2 }),
        ).toEqual(ok(undefined));
        const open = await createInvite(deps, moe.sessionToken);
        invariant(open.ok, "an open invite");
        expect(
            (
                await suspendAccount({
                    db,
                    caller: staff,
                    operationId: newOperationId(rng),
                    targetAccountId: moe.accountId,
                    reason: "spam",
                })
            ).ok,
        ).toBe(true);
        const strikes = async () => {
            const standing = await readInviteStanding(db, {
                caller: staff,
                accountId: ivy.accountId,
            });
            invariant(standing.ok, "the standing reads");
            return { invitees: standing.value.invitees, strikes: standing.value.strikes };
        };
        expect(await strikes()).toEqual({ invitees: 1, strikes: { ever: 1, now: 1 } });
        const auditOf = async () => {
            const rows = await queryAll(
                db,
                z.object({ id: z.string(), operation: z.string() }),
                sql`select id::text as id, operation from audit
                    where target ->> 'accountId' = ${moe.accountId} or actor_id = ${moe.accountId}
                    order by audit.id`,
            );
            invariant(rows.ok, "audit reads");
            return rows.value;
        };
        const auditBefore = await auditOf();
        expect(auditBefore.map((row) => row.operation)).toContain("account.suspend");

        const appeal = await withTx(db, (tx, txNow) =>
            mintSession(tx, {
                rng,
                accountId: moe.accountId,
                purpose: "appeal",
                txNow,
                client: null,
            }),
        );
        invariant(appeal.ok, "an appeal session");
        expect(
            (
                await requestDeletion(deps, {
                    token: appeal.value.token,
                    purpose: "appeal",
                    client: null,
                })
            ).ok,
        ).toBe(true);
        await lapse(db, moe.accountId);
        expect((await completeDeletion(deps, moe.accountId)).ok).toBe(true);

        expect(await strikes()).toEqual({ invitees: 1, strikes: { ever: 1, now: 1 } });
        const auditAfter = await auditOf();
        expect([...auditAfter].slice(0, auditBefore.length)).toEqual([...auditBefore]);
        expect(auditAfter.map((row) => row.operation)).toContain("account.deletion_completed");
        const edges = await queryAll(
            db,
            z.object({ inviter_id: z.string(), redeemed: z.boolean(), revoked: z.boolean() }),
            sql`select inviter_id, invitee_id is not null as redeemed, revoked_at is not null as revoked
                from invite where inviter_id in (${ivy.accountId}, ${moe.accountId}) order by id`,
        );
        expect(edges).toEqual(
            ok([
                { inviter_id: ivy.accountId, redeemed: true, revoked: false },
                { inviter_id: moe.accountId, redeemed: false, revoked: true },
            ]),
        );
    }),
);
