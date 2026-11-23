import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { type WebContract, webContract } from "@lucent/rpc/web";
import type { z } from "zod";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { execute, sql } from "../src/db/pool.ts";
import { webProcedures } from "../src/listeners/internal/web-rpc.ts";
import { memberSession, newSetupLink, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, product, seedAccount } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const SOMEONE = `acc_${"a".repeat(22)}`;
const OPERATION = "op-0123456789abcdef";

test("catalog RPCs separate public listings, grant options and a member's past holdings", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(303);
        const auth = await createTestAuthDeps(nativeDb, rng);
        const root = await memberSession(auth, await seedRootOnce(nativeDb, rng));
        const accountId = await seedAccount(nativeDb, rng, "holder@lucent.test");
        const member = await memberSession(auth, accountId);
        const stranger = await memberSession(
            auth,
            await seedAccount(nativeDb, rng, "stranger@lucent.test"),
        );
        const products = new Map(catalog());
        const cs2 = product("cs2");
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey: PEER_KEY,
            procedures: webProcedures,
            createContext: () => Promise.resolve(ok({ catalog: products, auth })),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey: PEER_KEY,
            fetcher: async (req) => await app.fetch(req),
        });
        const listed = async (session: typeof member) => {
            const reply = await client.call("products.list", {}, { session });
            invariant(reply.ok, "member catalog loaded");
            return reply.value.products.find((p) => p.productId === cs2.id) ?? null;
        };
        const grant = (session: typeof member) =>
            client.call(
                "admin.entitlements.issue",
                {
                    operationId: newOperationId(rng),
                    accountId,
                    validFrom: 0,
                    validUntil: null,
                    products: [{ productId: cs2.id, channels: ["stable"], features: "*" }],
                },
                { session },
            );
        const tokenHash = await hashToken(root);
        await execute(
            nativeDb,
            sql`update browser_session set step_up_at = now() where token_hash = ${tokenHash}`,
        );
        const publicIds = async (procedure: "catalog.products.list" | "catalog.list") => {
            const reply = await client.call(procedure, {});
            invariant(reply.ok, "public catalog loaded");
            return reply.value.map((p) => String(p.id));
        };
        expect(await publicIds("catalog.list")).toEqual(["lucent-loader"]);
        expect(await publicIds("catalog.products.list")).toEqual(["lucent-loader"]);
        expect(await listed(member)).toBeNull();
        expect(
            await client.call("admin.entitlements.listProducts", {}, { session: member }),
        ).toEqual(err({ code: "FORBIDDEN" }));
        const options = await client.call("admin.entitlements.listProducts", {}, { session: root });
        invariant(options.ok, "staff grant options loaded");
        expect(options.value.map((p) => String(p.id))).toEqual(["cs2", "lucent-loader"]);
        expect((await grant(root)).ok).toBe(true);
        expect(await listed(member)).toMatchObject({ state: "seed", features: "*" });
        for (const state of ["announced", "retired"] as const) {
            products.set(cs2.id, { ...cs2, state });
            expect(await grant(member)).toEqual(err({ code: "FORBIDDEN" }));
            expect(await grant(root)).toEqual(err({ code: "PRODUCT_NOT_ISSUABLE" }));
            expect(await publicIds("catalog.products.list")).toEqual(
                state === "announced" ? ["cs2", "lucent-loader"] : ["lucent-loader"],
            );
            expect(await listed(member)).toMatchObject({ state, features: [], channels: [] });
            expect((await listed(stranger))?.state ?? null).toBe(
                state === "announced" ? state : null,
            );
        }
        for (const end of [sql`valid_until = now()`, sql`status = 'revoked', valid_until = null`]) {
            const ended = await execute(
                nativeDb,
                sql`update entitlement set ${end} where account_id = ${accountId}`,
            );
            expect(ended).toEqual(ok(1));
            products.set(cs2.id, cs2);
            expect(await listed(member)).toBeNull();
            products.set(cs2.id, { ...cs2, state: "retired" });
            expect(await listed(member)).toMatchObject({
                state: "retired",
                features: [],
                channels: [],
            });
        }
    });
});

type SinglePurpose = {
    [K in keyof WebContract as WebContract[K]["session"] extends "member" | "setup"
        ? K
        : never]: z.input<WebContract[K]["input"]>;
};

// An input each procedure accepts, so the call gets as far as its session check. The type makes
// a procedure added with a single purpose fail to compile until it is listed here.
const inputs: SinglePurpose = {
    "cloud.products.list": {},
    "cloud.items.list": { productId: "cs2" },
    "cloud.items.create": { productId: "cs2", operationId: OPERATION, name: "one", kind: "config" },
    "cloud.items.history": { productId: "cs2", itemId: "1" },
    "cloud.items.rename": { productId: "cs2", itemId: "1", base: 1, name: "one" },
    "cloud.items.restore": { productId: "cs2", itemId: "1", base: 1, revision: 1 },
    "cloud.items.delete": { productId: "cs2", itemId: "1" },
    "cloud.shares.create": { productId: "cs2", itemId: "1" },
    "cloud.shares.revoke": { productId: "cs2", shareId: "1" },
    "cloud.shares.import": { productId: "cs2", token: "a".repeat(43) },
    "inbox.entries.list": { cursor: null },
    "inbox.entries.read": { id: "00000000-0000-4000-8000-000000000001" },
    "inbox.unread.count": {},
    "preferences.channels.list": {},
    "preferences.channels.set": { kind: "product_status", inbox: true, mail: false },
    "preferences.subscriptions.set": { productId: "cs2", following: true },
    "session.list": {},
    "session.endOthers": {},
    "setup.username.choose": { username: "unclaimed" },
    "stepUp.begin": {},
    "devices.signIn.read": { requestId: `lauth_${"a".repeat(22)}` },
    "devices.signIn.approve": { requestId: `lauth_${"a".repeat(22)}` },
    "devices.signIn.deny": { requestId: `lauth_${"a".repeat(22)}` },
    "devices.enrollments.list": {},
    "devices.enrollments.approve": { operationId: OPERATION, enrollmentId: "0".repeat(32) },
    "devices.enrollments.deny": { enrollmentId: "0".repeat(32) },
    "devices.list": {},
    "devices.rename": { deviceId: "0".repeat(32), name: "desk" },
    "devices.remove": { operationId: OPERATION, deviceId: "0".repeat(32) },
    "products.list": {},
    "admin.entitlements.listProducts": {},
    "download.loader": {},
    "admin.accounts.list": {
        filter: { status: null, roleId: null, text: null },
        sort: "newest",
        cursor: null,
    },
    "admin.accounts.get": { accountId: SOMEONE },
    "admin.accounts.create": { operationId: OPERATION, email: "new@lucent.test" },
    "admin.accounts.suspend": { operationId: OPERATION, accountId: SOMEONE, reason: "spam" },
    "admin.accounts.reinstate": { operationId: OPERATION, accountId: SOMEONE },
    "admin.accounts.rename": { operationId: OPERATION, accountId: SOMEONE, username: "renamed" },
    "admin.accounts.recover": { accountId: SOMEONE },
    "admin.entitlements.issue": {
        operationId: OPERATION,
        accountId: SOMEONE,
        validFrom: 0,
        validUntil: null,
        products: [{ productId: "cs2", features: "*", channels: ["stable"] }],
    },
    "admin.roles.list": {},
    "admin.roles.get": { roleId: "role_support" },
    "admin.roles.save": {
        operationId: OPERATION,
        roleId: "role_support",
        name: "Support",
        rank: 1,
        permissions: [],
    },
    "admin.roles.assign": { accountId: SOMEONE, roleId: "role_support", expiresAt: null },
    "admin.roles.unassign": { accountId: SOMEONE, roleId: "role_support" },
    "admin.releases.list": {},
    "admin.releases.promote": { productId: "cs2", channel: "alpha", number: "1" },
    "admin.facts.list": { releaseId: "0".repeat(32) },
    "admin.facts.promote": { releaseId: "0".repeat(32), setId: "1" },
    "admin.audit.list": {
        filter: { actorId: null, targetAccountId: null, operation: null, before: null },
        cursor: null,
    },
    "privacy.restrictions.list": {},
    "profile.get": { username: "someone" },
    "profile.bio.set": { bio: "hello" },
    "guides.list": { productId: "cs2", cursor: null },
    "guides.get": { id: "00000000-0000-4000-8000-000000000001" },
    "guides.create": { productId: "cs2", title: "title", body: "body" },
    "guides.update": { id: "00000000-0000-4000-8000-000000000001", title: "title", body: "body" },
    "comments.list": { guideId: "00000000-0000-4000-8000-000000000001", cursor: null },
    "comments.create": { guideId: "00000000-0000-4000-8000-000000000001", body: "body" },
    "shouts.list": { productId: null, cursor: null },
    "shouts.create": { productId: null, body: "body" },
    "admin.moderation.restrictions.list": { cursor: null },
    "admin.moderation.restrictions.set": {
        username: "someone",
        kind: "muted",
        productId: null,
        reason: "spam",
        endsAt: null,
    },
    "admin.moderation.restrictions.lift": { id: "00000000-0000-4000-8000-000000000001" },
    "stepUp.finish": {
        flowToken: "f".repeat(43),
        response: {
            id: "AAAA",
            rawId: "AAAA",
            type: "public-key",
            clientExtensionResults: {},
            response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA" },
        },
    },
};

// The contract's `session` is what web reads to decide which session to send; the handler's own
// transaction is what enforces it. A mismatch would let a setup session do a member's work.
test("every single-purpose procedure refuses a session of the other purpose", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(41);
        const auth = await createTestAuthDeps(nativeDb, rng);
        const link = await newSetupLink(auth, rng, "purpose@lucent.test");
        const setup = await redeemSetupLink(auth, { setupToken: link.setupToken });
        invariant(setup.ok, "redeeming the setup link failed");
        const sessions = {
            member: await memberSession(auth, link.accountId),
            setup: setup.value.sessionToken,
        };
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey: PEER_KEY,
            procedures: webProcedures,
            createContext: () => Promise.resolve(ok({ catalog: new Map(), auth })),
            onUnhandledError: () => {},
        });

        const contracts = new Map(Object.entries(webContract));
        for (const [name, input] of Object.entries(inputs)) {
            const declared = contracts.get(name)?.session;
            const other = declared === "member" ? sessions.setup : sessions.member;
            const res = await app.fetch(
                new Request("http://localhost/rpc", {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${PEER_KEY}`,
                        "content-type": "application/json",
                        "lucent-session": other,
                    },
                    body: JSON.stringify({ procedure: name, input }),
                }),
            );
            expect({ name, reply: await res.json() }).toEqual({
                name,
                reply: err({ code: "SESSION_INVALID" }),
            });
        }
    });
});

test("adding an account through the contract needs a step-up and shows the setup link once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
        const rng = createSeededRng(42);
        const auth = await createTestAuthDeps(browserDb, rng);
        const rootId = await seedRootOnce(browserDb, rng);
        const session = await memberSession(auth, rootId);
        const app = mountInternalRpc({
            path: "/rpc",
            peerKey: PEER_KEY,
            procedures: webProcedures,
            createContext: () => Promise.resolve(ok({ catalog: new Map(), auth })),
            onUnhandledError: () => {},
        });
        const client = createRpcClient(webContract, {
            endpointUrl: "http://localhost/rpc",
            peerKey: PEER_KEY,
            fetcher: async (req) => await app.fetch(req),
        });
        const input = { operationId: newOperationId(rng), email: "new@lucent.test" };

        expect(await client.call("admin.accounts.create", input, { session })).toEqual(
            err({ code: "STEP_UP_REQUIRED", withinSeconds: 1_800 }),
        );
        const tokenHash = await hashToken(session);
        await execute(
            nativeDb,
            sql`update browser_session set step_up_at = now() where token_hash = ${tokenHash}`,
        );
        const created = await client.call("admin.accounts.create", input, { session });
        invariant(created.ok, `create failed: ${JSON.stringify(created)}`);
        expect(created.value.setupToken).not.toBeNull();
        expect(await client.call("admin.accounts.create", input, { session })).toEqual(
            ok({ accountId: created.value.accountId, setupToken: null }),
        );
    });
});
