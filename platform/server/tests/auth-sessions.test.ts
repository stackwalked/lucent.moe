import { expect, test } from "bun:test";
import { z } from "zod";
import { setPassword } from "../src/auth/credentials.ts";
import { listSessions, signOutSession } from "../src/auth/sessions.ts";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { resolveViewer } from "../src/auth/viewer.ts";
import { invariant } from "../src/core/contain.ts";
import { err, ok } from "../src/core/result.ts";
import { createSeededRng } from "../src/core/rng.ts";
import { ClientInfo, EpochMs, newSessionId } from "../src/core/scalars.ts";
import { execute, sql } from "../src/db/pool.ts";
import { memberSession, newMember, newSetupLink } from "./auth-fixtures.ts";
import { grantRole, scalar, seedRole } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const FIREFOX = ClientInfo.parse({ ip: "203.0.113.7", userAgent: "Firefox/140.0" });
const PHONE = ClientInfo.parse({ ip: "2001:db8::1", userAgent: "Mobile Safari/18.0" });

const Seconds = z.coerce.number();

test("a member session lasts seven days and a setup session thirty minutes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
        const rng = createSeededRng(501);
        const deps = await createTestAuthDeps(browserDb, rng);
        const link = await newSetupLink(deps, rng, "lifetimes@lucent.test");
        const setup = await redeemSetupLink(deps, { setupToken: link.setupToken });
        invariant(setup.ok, "redeeming the setup link failed");
        await memberSession(deps, link.accountId);

        const lifetime = (purpose: string) =>
            scalar(
                nativeDb,
                Seconds,
                sql`select extract(epoch from expires_at - created_at) as value
                    from browser_session where account_id = ${link.accountId}
                      and purpose = ${purpose}`,
            );
        expect(await lifetime("member")).toBe(7 * 24 * 60 * 60);
        expect(await lifetime("setup")).toBe(30 * 60);
    });
});

test("the session list shows the holder's live sessions, where each came from, and which is this one", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(502);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const bob = await newMember(deps, rng, { username: "bob", with: "passkey" });
        await memberSession(deps, alice.accountId, PHONE);

        const listed = await listSessions(browserDb, { sessionToken: alice.sessionToken });
        invariant(listed.ok, `listing failed: ${JSON.stringify(listed)}`);
        // newMember's setup session is still live too: it's a way in, so it's listed.
        const seen = listed.value.map((s) => ({
            purpose: s.purpose,
            ...s.client,
            current: s.current,
        }));
        expect(seen).toHaveLength(3);
        expect(seen).toContainEqual({
            purpose: "member",
            ip: null,
            userAgent: null,
            current: true,
        });
        expect(seen).toContainEqual({
            purpose: "member",
            ip: "2001:db8::1",
            userAgent: "Mobile Safari/18.0",
            current: false,
        });
        expect(seen).toContainEqual({
            purpose: "setup",
            ip: null,
            userAgent: null,
            current: false,
        });
        const lastSeen = listed.value.map((s) => s.lastSeenAt);
        expect(lastSeen).toEqual([...lastSeen].sort((a, b) => b - a));
        const bobs = await listSessions(browserDb, { sessionToken: bob.sessionToken });
        invariant(bobs.ok, "bob lists his own");
        const alices = new Set(listed.value.map((s) => s.sessionId));
        expect(bobs.value.some((s) => alices.has(s.sessionId))).toBe(false);
    });
});

test("ending a session by its id signs out that session only, and only the holder's own", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb }) => {
        const rng = createSeededRng(503);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const bob = await newMember(deps, rng, { username: "bob", with: "passkey" });
        const laptop = await memberSession(deps, alice.accountId);
        const laptopViewer = await resolveViewer(browserDb, { sessionToken: laptop, client: null });
        invariant(laptopViewer.ok, "the laptop session resolves");
        const laptopId = laptopViewer.value.sessionId;

        expect(
            await signOutSession(browserDb, {
                sessionToken: bob.sessionToken,
                sessionId: laptopId,
            }),
        ).toEqual(ok(undefined));
        expect((await resolveViewer(browserDb, { sessionToken: laptop, client: null })).ok).toBe(
            true,
        );

        expect(
            await signOutSession(browserDb, {
                sessionToken: alice.sessionToken,
                sessionId: laptopId,
            }),
        ).toEqual(ok(undefined));
        expect(await resolveViewer(browserDb, { sessionToken: laptop, client: null })).toEqual(
            err({ code: "SESSION_INVALID" }),
        );
        expect(
            (await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: null })).ok,
        ).toBe(true);
        expect(
            await signOutSession(browserDb, {
                sessionToken: alice.sessionToken,
                sessionId: newSessionId(rng),
            }),
        ).toEqual(ok(undefined));
    });
});

test("resolving a session refreshes when and where it was last seen at most every five minutes", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
        const rng = createSeededRng(504);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const tokenHash = await hashToken(alice.sessionToken);
        const seenAgo = (minutes: number) =>
            execute(
                nativeDb,
                sql`update browser_session
                    set last_seen_at = now() - make_interval(mins => ${minutes})
                    where token_hash = ${tokenHash}`,
            );
        const lastSeen = () =>
            scalar(
                nativeDb,
                z.object({ seconds: Seconds, ip: z.string().nullable() }),
                sql`select json_build_object(
                           'seconds', extract(epoch from now() - last_seen_at),
                           'ip', host(client_ip)) as value
                    from browser_session where token_hash = ${tokenHash}`,
            );

        await seenAgo(4);
        await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: FIREFOX });
        const recent = await lastSeen();
        expect([Math.round(recent.seconds / 60), recent.ip]).toEqual([4, null]);

        await seenAgo(6);
        await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: FIREFOX });
        const refreshed = await lastSeen();
        expect([Math.round(refreshed.seconds), refreshed.ip]).toEqual([0, "203.0.113.7"]);
    });
});

test("the viewer carries the standing its unexpired roles give", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
        const rng = createSeededRng(505);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const support = await seedRole(nativeDb, {
            id: "role_support",
            rank: 10,
            permissions: ["accounts:read", "audit:read", "retired:action"],
        });
        const lapsed = await seedRole(nativeDb, {
            id: "role_lapsed",
            rank: 50,
            permissions: ["roles:manage"],
        });
        await grantRole(nativeDb, { accountId: alice.accountId, roleId: support });
        await grantRole(nativeDb, {
            accountId: alice.accountId,
            roleId: lapsed,
            expiresAt: EpochMs.parse(1_000),
        });

        const viewer = await resolveViewer(browserDb, {
            sessionToken: alice.sessionToken,
            client: null,
        });
        invariant(viewer.ok, "alice resolves");
        expect(viewer.value.username).toBe("alice");
        expect(viewer.value.standing).toEqual({
            isRoot: false,
            maxRank: 10,
            permissions: ["accounts:read", "audit:read"],
        });
    });
});

test("an audit entry records the client web reported for the request", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
        const rng = createSeededRng(506);
        const deps = await createTestAuthDeps(browserDb, rng);
        const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
        const set = await setPassword(deps, {
            sessionToken: alice.sessionToken,
            password: "another long passphrase",
            client: FIREFOX,
        });
        expect(set).toEqual(ok(undefined));
        expect(
            await scalar(
                nativeDb,
                z.object({ ip: z.string(), userAgent: z.string() }),
                sql`select json_build_object('ip', host(client_ip), 'userAgent', user_agent) as value
                    from audit where operation = 'credential.password_set'`,
            ),
        ).toEqual({ ip: "203.0.113.7", userAgent: "Firefox/140.0" });
    });
});
