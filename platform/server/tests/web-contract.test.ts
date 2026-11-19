import { expect, test } from "bun:test";
import type { z } from "zod";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { type WebContract, webContract } from "../src/contract/web.ts";
import { invariant } from "../src/core/contain.ts";
import { err, ok } from "../src/core/result.ts";
import { createSeededRng } from "../src/core/rng.ts";
import { mountInternalRpc } from "../src/core/rpc.ts";
import { webProcedures } from "../src/internal/web-rpc.ts";
import { memberSession, newSetupLink } from "./auth-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

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
