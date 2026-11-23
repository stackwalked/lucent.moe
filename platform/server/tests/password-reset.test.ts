import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { BearerToken } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { mountInternalRpc } from "@lucent/rpc/mount";
import { webContract } from "@lucent/rpc/web";
import { AuthenticationResponse } from "@lucent/rpc/webauthn";
import { z } from "zod";
import { createMailTransport } from "../src/adapters/mail/mail.ts";
import { setPassword } from "../src/auth/credentials.ts";
import type { AuthDeps } from "../src/auth/deps.ts";
import { redeemPasswordReset, requestPasswordReset } from "../src/auth/password-reset.ts";
import { issueSetupToken, redeemSetupLink } from "../src/auth/setup.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../src/auth/sign-in.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { resolveViewer } from "../src/auth/viewer.ts";
import { recoverAccount } from "../src/authority/writers.ts";
import { type Db, execute, queryOne, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import { webProcedures } from "../src/listeners/internal/web-rpc.ts";
import { mailDeliveryJob } from "../src/notify/mail.ts";
import { codeAt, MEMBER_PASSWORD, newMember, seedRootOnce } from "./auth-fixtures.ts";
import { catalog, grantRole, seedRole, steppedUp } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const password = "an entirely different password";
const invalid = err({ code: "RESET_INVALID" });
function publicRpc(auth: AuthDeps) {
    const peerKey = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
    const app = mountInternalRpc({
        path: "/rpc",
        peerKey,
        procedures: webProcedures,
        createContext: async () => ok({ auth, catalog: catalog() }),
        onUnhandledError: () => {},
    });
    return createRpcClient(webContract, {
        endpointUrl: "http://localhost/rpc",
        peerKey,
        fetcher: async (req) => app.fetch(req),
    });
}
// Read the link only from the request the real adapter hands to its offline transport.
async function receive(db: Db) {
    const links: URL[] = [];
    const mail = await createMailTransport(
        { provider: "resend", apiKey: "fixture", sender: "from@lucent.test" },
        async (req) => {
            const { text } = z.object({ text: z.string() }).parse(await req.json());
            const link = text.split("\n").find((line) => line.includes("/reset-password#"));
            invariant(link !== undefined, "expected a reset email");
            links.push(new URL(link));
            return Response.json({ id: "offline" });
        },
    );
    const job = mailDeliveryJob({ db, mail });
    expect(await job.run()).toEqual(ok("resend: accepted"));
    expect(await job.run()).toEqual(ok(null));
    invariant(links.length === 1 && links[0] !== undefined, "exactly one reset email");
    expect(links[0].pathname).toBe("/reset-password");
    expect(links[0].search).toBe("");
    return BearerToken.parse(links[0].hash.slice(1));
}

test("reset requests for missing, staff and eligible accounts have the same padded reply; only one link enters the drain", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8201);
        const deps = await createTestAuthDeps(db, rng);
        const member = await newMember(deps, rng, { username: "alice", with: "all" });
        const staff = await newMember(deps, rng, { username: "staffer", with: "passkey" });
        await grantRole(db, {
            accountId: staff.accountId,
            roleId: await seedRole(db, {
                id: "role_help",
                rank: 1,
                permissions: ["tickets:reply"],
            }),
        });
        const rpc = publicRpc(deps);
        const times = [];
        for (const email of [
            "staffer@lucent.test",
            "missing@lucent.test",
            "alice@lucent.test",
            "alice@lucent.test",
        ]) {
            const start = performance.now();
            expect(await rpc.call("reset.password.request", { email })).toEqual(ok({}));
            times.push(performance.now() - start);
        }
        expect(Math.min(...times)).toBeGreaterThanOrEqual(345);
        expect(Math.max(...times) - Math.min(...times)).toBeLessThan(100);
        expect(
            (await resolveViewer(db, { sessionToken: member.sessionToken, client: null })).ok,
        ).toBe(true);
        const token = await receive(db);
        expect(
            await queryOne(
                db,
                z.object({ token_hash: z.instanceof(Uint8Array) }),
                sql`select token_hash from password_reset where account_id=${member.accountId}`,
            ),
        ).toEqual(ok({ token_hash: new Uint8Array(await hashToken(token)) }));
        const setup = await withTx(db, (tx, txNow) =>
            issueSetupToken(tx, { accountId: member.accountId, rng, issuedBy: "test", txNow }),
        );
        const oldPassword = await signInWithPassword(deps, {
            username: "alice",
            password: MEMBER_PASSWORD,
        });
        invariant(
            setup.ok && oldPassword.ok && oldPassword.value.next === "secondFactor",
            "older links and pending password challenge exist",
        );
        const anonymous = await beginPasskeySignIn(deps, { flowToken: null });
        invariant(anonymous.ok && member.passkey !== null, "discoverable passkey");
        const staleAssertion = AuthenticationResponse.parse(
            await member.passkey.assert(anonymous.value.options),
        );
        const results = await Promise.all(
            [1, 2].map(() => rpc.call("reset.password.redeem", { token, password })),
        );
        expect(results.filter((r) => r.ok)).toEqual([ok({})]);
        expect(results.filter((r) => !r.ok)).toEqual([invalid]);
        expect(await redeemSetupLink(deps, { setupToken: setup.value })).toEqual(
            err({ code: "SETUP_INVALID" }),
        );
        expect(
            await signInWithTotp(deps, { flowToken: oldPassword.value.flowToken, code: "000000" }),
        ).toEqual(err({ code: "FLOW_INVALID" }));
        expect(
            await resolveViewer(db, { sessionToken: member.sessionToken, client: null }),
        ).toEqual(err({ code: "SESSION_INVALID" }));
        expect(
            await finishPasskeySignIn(deps, {
                flowToken: anonymous.value.flowToken,
                response: staleAssertion,
            }),
        ).toEqual(err({ code: "FLOW_INVALID" }));
        expect(
            await signInWithPassword(deps, { username: "alice", password: MEMBER_PASSWORD }),
        ).toEqual(err({ code: "INVALID_CREDENTIALS" }));
        const flow = await signInWithPassword(
            { ...deps, passwordOnly: true },
            { username: "alice", password },
        );
        invariant(
            flow.ok && flow.value.next === "secondFactor" && member.totpSecret !== null,
            "dev bypass does not unlock reset",
        );
        expect(flow.value.secondFactors).toEqual(["totp", "passkey"]);
        expect(
            (
                await signInWithTotp(deps, {
                    flowToken: flow.value.flowToken,
                    code: await codeAt(db, member.totpSecret, 1),
                })
            ).ok,
        ).toBe(true);
        expect(
            await queryOne(
                db,
                z.object({ reset_lock: z.boolean() }),
                sql`select reset_lock from account where id = ${member.accountId}`,
            ),
        ).toEqual(ok({ reset_lock: false }));
    });
});

test.each([
    "staff recovery",
    "suspension",
    "promotion",
    "expiry",
    "lock",
    "lost factors",
    "password change",
] as const)("redemption rechecks %s and never changes a now-ineligible account", async (change) => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8202);
        const deps = await createTestAuthDeps(db, rng);
        const member = await newMember(deps, rng, { username: "alice", with: "all" });
        expect(await requestPasswordReset(deps, "alice@lucent.test")).toEqual(ok(undefined));
        const token = await receive(db);
        if (change === "lost factors") {
            expect(
                (await execute(db, sql`delete from passkey where account_id=${member.accountId}`))
                    .ok,
            ).toBe(true);
            expect(
                (
                    await execute(
                        db,
                        sql`delete from totp_credential where account_id=${member.accountId}`,
                    )
                ).ok,
            ).toBe(true);
            expect(
                await signInWithPassword(deps, {
                    username: "alice",
                    password: MEMBER_PASSWORD,
                }),
            ).toEqual(err({ code: "NO_SECOND_FACTOR" }));
        }
        if (change === "staff recovery") {
            const caller = await steppedUp(db, await seedRootOnce(db, rng));
            expect(
                (await recoverAccount({ db, rng, caller, targetAccountId: member.accountId })).ok,
            ).toBe(true);
        }
        if (change === "promotion")
            await grantRole(db, {
                accountId: member.accountId,
                roleId: await seedRole(db, {
                    id: "role_helper",
                    rank: 10,
                    permissions: ["audit:read"],
                }),
            });
        if (change === "suspension")
            expect(
                (
                    await execute(
                        db,
                        sql`update account set status = 'suspended' where id = ${member.accountId}`,
                    )
                ).ok,
            ).toBe(true);
        if (change === "lock")
            expect(
                (
                    await execute(
                        db,
                        sql`update account set is_locked = true where id = ${member.accountId}`,
                    )
                ).ok,
            ).toBe(true);
        if (change === "password change")
            expect(
                await setPassword(deps, {
                    sessionToken: member.sessionToken,
                    password: "a password chosen while signed in",
                }),
            ).toEqual(ok(undefined));
        if (change === "expiry")
            expect((await execute(db, sql`update password_reset set expires_at = now()`)).ok).toBe(
                true,
            );
        expect(await redeemPasswordReset(deps, { token, password })).toEqual(invalid);
    });
});

test("a fresh enrolled passkey clears the reset gate without a password-only session", async () => {
    await (await sharedTestCluster()).withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(8203);
        const deps = await createTestAuthDeps(db, rng);
        const member = await newMember(deps, rng, { username: "alice", with: "passkey" });
        expect(await requestPasswordReset(deps, "alice@lucent.test")).toEqual(ok(undefined));
        expect(await redeemPasswordReset(deps, { token: await receive(db), password })).toEqual(
            ok(undefined),
        );
        const flow = await beginPasskeySignIn(deps, { flowToken: null });
        invariant(flow.ok && member.passkey !== null, "fresh passkey challenge");
        expect(
            (
                await finishPasskeySignIn(deps, {
                    flowToken: flow.value.flowToken,
                    response: AuthenticationResponse.parse(
                        await member.passkey.assert(flow.value.options),
                    ),
                })
            ).ok,
        ).toBe(true);
        expect(
            await queryOne(
                db,
                z.object({ reset_lock: z.boolean() }),
                sql`select reset_lock from account where id = ${member.accountId}`,
            ),
        ).toEqual(ok({ reset_lock: false }));
    });
});
