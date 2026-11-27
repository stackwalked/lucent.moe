import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { type AccountId, BearerToken, RoleId, toBase64Url } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { matchCodeOf } from "../src/base/core/ids.ts";
import { type Db, execute, sql } from "../src/base/db/pool.ts";
import { withTx } from "../src/base/db/tx.ts";
import { webProcedures } from "../src/edge/listeners/internal/web-rpc.ts";
import { hashToken } from "../src/identity/auth/tokens.ts";
import { matchCodeDigits, thumbprintPrefix } from "../src/identity/authority/search.ts";
import { memberSession } from "./auth-fixtures.ts";
import { catalog, grantRole, seedAccount, seedRole } from "./authority-fixtures.ts";
import { NO_LOG } from "./community-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

async function world(seed: number, body: (w: Awaited<ReturnType<typeof build>>) => Promise<void>) {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb: db }) => {
        await body(await build(db, seed));
    });
}

async function build(db: Db, seed: number) {
    const rng = createSeededRng(seed);
    const auth = await createTestAuthDeps(db, rng);
    const app = mountInternalRpc({
        path: "/rpc",
        peerKey,
        procedures: webProcedures,
        createContext: () => Promise.resolve(ok({ auth, catalog: catalog(), logger: NO_LOG })),
        onUnhandledError: () => {},
    });
    const client = createRpcClient(webContract, {
        endpointUrl: "http://localhost/rpc",
        peerKey,
        fetcher: (req) => Promise.resolve(app.fetch(req)),
    });
    let n = 0;
    const member = async (name: string, permissions: readonly string[] | null) => {
        const id = await seedAccount(db, rng, `${name}@search.test`);
        const set = await execute(db, sql`update account set username = ${name} where id = ${id}`);
        invariant(set.ok, "username set");
        if (permissions !== null) {
            const roleId = RoleId.parse(`role_${name}`);
            await seedRole(db, { id: roleId, rank: 5, permissions });
            await grantRole(db, { accountId: id, roleId });
        }
        return { id, call: { session: await memberSession(auth, id) } };
    };
    const pc = async (accountId: AccountId) => {
        n += 1;
        const jkt = toBase64Url(new Uint8Array(32).map((_, i) => (i === 0 ? n * 7 : i + n)));
        const hex = n.toString(16).padStart(32, "0");
        const made = await execute(
            db,
            sql`insert into device (id, account_id, jkt, public_key, storage, enrolled_at)
                values (decode(${hex}, 'hex'), ${accountId}, ${jkt}, '{}', 'software', now())`,
        );
        invariant(made.ok, "device");
        return { hex, code: matchCodeOf(jkt) };
    };
    const invite = async (inviter: AccountId, token: BearerToken) => {
        const made = await execute(
            db,
            sql`insert into invite (inviter_id, token_hash, created_at, expires_at)
                values (${inviter}, ${await hashToken(token)}, now(), now() + interval '7 days')`,
        );
        invariant(made.ok, "invite");
    };
    const ticket = async (
        accountId: AccountId,
        kind: "help" | "appeal",
        subject: string | null,
    ) => {
        const made = await execute(
            db,
            sql`insert into ticket (account_id, kind, subject, state, opened_at, last_activity_at)
                values (${accountId}, ${kind}, ${subject}, 'open', now(), now())`,
        );
        invariant(made.ok, "ticket");
    };
    return { db, client, member, pc, invite, ticket };
}

const TOKEN = BearerToken.parse("A".repeat(43));
const forbidden = err({ code: "FORBIDDEN" });

test("a role holding only accounts:read finds accounts, pcs and invites but no tickets", async () => {
    await world(21101, async (w) => {
        const staff = await w.member("reader", ["accounts:read"]);
        const ana = await w.member("anabel", null);
        const pc = await w.pc(ana.id);
        await w.invite(ana.id, TOKEN);
        await w.ticket(ana.id, "help", "anabel needs help");
        const found = await w.client.call("admin.search", { text: "anab" }, staff.call);
        invariant(found.ok, "expected results");
        expect(found.value.accounts.map((a) => a.username)).toEqual(["anabel"]);
        expect(found.value.tickets).toEqual([]);
        const byCode = await w.client.call("admin.search", { text: pc.code }, staff.call);
        invariant(byCode.ok, "expected results");
        expect(byCode.value.pcs).toEqual([{ id: pc.code, accountId: ana.id, username: "anabel" }]);
        const byInvite = await w.client.call(
            "admin.search",
            { text: `https://x.test/invite#${TOKEN}` },
            staff.call,
        );
        invariant(byInvite.ok, "expected results");
        expect(byInvite.value.invites.map((i) => i.inviterUsername)).toEqual(["anabel"]);
    });
});

test("a role holding only tickets:reply finds tickets and nothing of accounts, pcs or invites", async () => {
    await world(21102, async (w) => {
        const staff = await w.member("replier", ["tickets:reply"]);
        const ana = await w.member("anabel", null);
        const pc = await w.pc(ana.id);
        await w.invite(ana.id, TOKEN);
        await w.ticket(ana.id, "help", "Overlay crashes");
        const found = await w.client.call("admin.search", { text: "overlay" }, staff.call);
        invariant(found.ok, "expected results");
        expect(found.value.tickets.map((t) => t.subject)).toEqual(["Overlay crashes"]);
        const rest = await w.client.call("admin.search", { text: "anab" }, staff.call);
        invariant(rest.ok, "expected results");
        expect(rest.value).toEqual({ accounts: [], pcs: [], invites: [], tickets: [] });
        for (const text of [pc.code, TOKEN]) {
            const none = await w.client.call("admin.search", { text }, staff.call);
            invariant(none.ok, "expected results");
            expect(none.value.pcs).toEqual([]);
            expect(none.value.invites).toEqual([]);
        }
    });
});

test("a member who is not staff is refused", async () => {
    await world(21103, async (w) => {
        const plain = await w.member("plain", null);
        expect(await w.client.call("admin.search", { text: "plain" }, plain.call)).toEqual(
            forbidden,
        );
        const other = await w.member("other", ["roles:manage"]);
        expect(await w.client.call("admin.search", { text: "plain" }, other.call)).toEqual(
            forbidden,
        );
    });
});

test("tickets match by exact id, appeals by id only, and pcs by device id", async () => {
    await world(21104, async (w) => {
        const staff = await w.member("both", ["accounts:read", "tickets:reply"]);
        const ana = await w.member("anabel", null);
        const bo = await w.member("bo", null);
        await w.ticket(ana.id, "help", "Subject here");
        await w.ticket(bo.id, "appeal", null);
        const all = await w.client.call("admin.search", { text: "subject" }, staff.call);
        invariant(all.ok, "expected results");
        const [helpTicket] = all.value.tickets;
        invariant(helpTicket !== undefined, "expected the help ticket");
        const byId = await w.client.call(
            "admin.search",
            { text: helpTicket.id.toUpperCase() },
            staff.call,
        );
        invariant(byId.ok, "expected results");
        expect(byId.value.tickets.map((t) => t.id)).toEqual([helpTicket.id]);
        const none = await w.client.call("admin.search", { text: "appeal" }, staff.call);
        invariant(none.ok, "expected results");
        expect(none.value.tickets).toEqual([]);
        const pc = await w.pc(ana.id);
        const byDevice = await w.client.call("admin.search", { text: pc.hex }, staff.call);
        invariant(byDevice.ok, "expected results");
        expect(byDevice.value.pcs.map((p) => p.id)).toEqual([pc.code]);
    });
});

test("results are capped at five, tombstones are left out, suspended accounts are found, wildcards are literal", async () => {
    await world(21105, async (w) => {
        const staff = await w.member("finder", ["accounts:read"]);
        for (let i = 0; i < 7; i += 1) await w.member(`zed${i}`, null);
        const capped = await w.client.call("admin.search", { text: "zed" }, staff.call);
        invariant(capped.ok, "expected results");
        expect(capped.value.accounts).toHaveLength(5);

        const gone = await w.member("gonezed", null);
        const sus = await w.member("suszed", null);
        const tombstoned = await withTx(w.db, async (tx) => {
            const allowed = await execute(
                tx,
                sql`select set_config('lucent.username_rename', 'on', true)`,
            );
            if (!allowed.ok) return allowed;
            return await execute(
                tx,
                sql`update account set deleted_at = now(), email = null, username = null,
                    suspended_at_deletion = false where id = ${gone.id}`,
            );
        });
        expect(tombstoned.ok).toBe(true);
        expect(
            (await execute(w.db, sql`update account set status = 'suspended' where id = ${sus.id}`))
                .ok,
        ).toBe(true);
        const names = await w.client.call("admin.search", { text: "suszed" }, staff.call);
        invariant(names.ok, "expected results");
        expect(names.value.accounts.map((a) => a.username)).toEqual(["suszed"]);
        const deleted = await w.client.call("admin.search", { text: "gone" }, staff.call);
        invariant(deleted.ok, "expected results");
        expect(deleted.value.accounts).toEqual([]);

        for (const text of ["%%", "__", "z_d", "z%"]) {
            const literal = await w.client.call("admin.search", { text }, staff.call);
            invariant(literal.ok, "expected results");
            expect(literal.value.accounts).toEqual([]);
        }
        const underscore = await w.member("under_score", null);
        const exact = await w.client.call("admin.search", { text: "under_" }, staff.call);
        invariant(exact.ok, "expected results");
        expect(exact.value.accounts.map((a) => a.id)).toEqual([underscore.id]);
    });
});

test.each([
    ["a full code", "ABCD-EFGH", "ABCDEFGH"],
    ["lowercase, no dash", "abcdefgh", "ABCDEFGH"],
    ["a prefix of four", "abcd", "ABCD"],
    ["too short", "abc", null],
    ["not crockford", "ABCD-EFGU", null],
] as const)("a typed match code: %s", (_name, text, digits) => {
    expect(matchCodeDigits(text)).toBe(digits);
});

test("the thumbprint prefix of a match code is the base64url start of the key it came from", () => {
    const digest = new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256);
    const jkt = toBase64Url(digest);
    const digits = matchCodeOf(jkt).replace("-", "");
    for (const length of [4, 5, 6, 8]) {
        expect(jkt.startsWith(thumbprintPrefix(digits.slice(0, length)))).toBe(true);
    }
});

test("a search of fewer than two characters, once trimmed, is refused before anything is read", async () => {
    await world(21103, async (w) => {
        const staff = await w.member("reader", ["accounts:read"]);
        await w.member("anabel", null);
        for (const text of ["a", " a ", " ", ""]) {
            const refused = await w.client.call("admin.search", { text }, staff.call);
            expect(!refused.ok && refused.error.code).toBe("INVALID_REQUEST");
        }
        const found = await w.client.call("admin.search", { text: " an " }, staff.call);
        invariant(found.ok, "two characters are enough");
        expect(found.value.accounts.map((a) => a.username)).toEqual(["anabel"]);
    });
});
