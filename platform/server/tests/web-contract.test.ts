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
import { webProcedures } from "../src/internal/web-rpc.ts";
import { memberSession, newSetupLink, seedRootOnce } from "./auth-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const SOMEONE = `acc_${"a".repeat(22)}`;
const OPERATION = "op-0123456789abcdef";

type SinglePurpose = {
    [K in keyof WebContract as WebContract[K]["session"] extends "member" | "setup"
        ? K
        : never]: z.input<WebContract[K]["input"]>;
};

// An input each procedure accepts, so the call gets as far as its session check. The type makes
// a procedure added with a single purpose fail to compile until it is listed here.
const inputs: SinglePurpose = {
    "session.list": {},
    "session.endOthers": {},
    "setup.username.choose": { username: "unclaimed" },
    "stepUp.begin": {},
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
    "admin.audit.list": {
        filter: { actorId: null, targetAccountId: null, operation: null, before: null },
        cursor: null,
    },
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
