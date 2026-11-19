import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, toHex } from "@lucent/core/scalars";
import { STEP_UP_WINDOW_SECONDS } from "@lucent/policy/policy";
import { AuthenticationResponse, RegistrationResponse } from "@lucent/rpc/webauthn";
import { z } from "zod";
import {
    beginPasskeyRegistration,
    beginStepUp,
    finishPasskeyRegistration,
    finishStepUp,
    removeCredential,
    setPassword,
} from "../src/auth/credentials.ts";
import { signOutOthers } from "../src/auth/sessions.ts";
import { redeemSetupLink } from "../src/auth/setup.ts";
import { signInWithPassword } from "../src/auth/sign-in.ts";
import { hashToken } from "../src/auth/tokens.ts";
import { resolveViewer } from "../src/auth/viewer.ts";
import { createAccount, recoverAccount } from "../src/authority/writers.ts";
import { execute, queryAll, sql } from "../src/db/pool.ts";
import { withTx } from "../src/db/tx.ts";
import {
    MEMBER_PASSWORD,
    memberSession,
    newMember,
    newSetupLink,
    registerPasskey,
    seedRootOnce,
} from "./auth-fixtures.ts";
import { steppedUp, waitForLockWaiters } from "./authority-fixtures.ts";
import { createTestAuthDeps } from "./harness/auth.ts";
import { createTestAuthenticator } from "./harness/authenticator.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

describe("browser sessions", () => {
    test("a member session ends when it expires, however much it's used", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(301);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            const first = await resolveViewer(browserDb, {
                sessionToken: alice.sessionToken,
                client: null,
            });
            const second = await resolveViewer(browserDb, {
                sessionToken: alice.sessionToken,
                client: null,
            });
            invariant(first.ok && second.ok, "a fresh session resolves");
            expect(second.value.expiresAt).toBe(first.value.expiresAt);

            const tokenHash = await hashToken(alice.sessionToken);
            await execute(
                nativeDb,
                sql`update browser_session set expires_at = now() where token_hash = ${tokenHash}`,
            );
            expect(
                await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: null }),
            ).toEqual(err({ code: "SESSION_INVALID" }));
        });
    });

    test("a suspended account's sessions stop resolving", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(302);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${alice.accountId}`,
            );
            expect(
                await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: null }),
            ).toEqual(err({ code: "SESSION_INVALID" }));
        });
    });

    test("a setup session can't do what a member session does", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(303);
            const deps = await createTestAuthDeps(browserDb, rng);
            const link = await newSetupLink(deps, rng, "alice@lucent.test");
            const setup = await redeemSetupLink(deps, { setupToken: link.setupToken });
            invariant(setup.ok, "the link is fresh");
            const sessionToken = setup.value.sessionToken;
            expect(await beginStepUp(deps, { sessionToken })).toEqual(
                err({ code: "SESSION_INVALID" }),
            );
            expect(await signOutOthers(browserDb, { sessionToken })).toEqual(
                err({ code: "SESSION_INVALID" }),
            );
        });
    });

    test("the database holds only hashes of the tokens browsers carry", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(304);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            const link = await newSetupLink(deps, rng, "bob@lucent.test");
            const flow = await signInWithPassword(deps, {
                username: "alice",
                password: MEMBER_PASSWORD,
            });
            invariant(flow.ok, "the password is right");

            const rows = await queryAll(
                nativeDb,
                z.object({ row: z.string() }),
                sql`select row_to_json(s)::text as row from browser_session s
                    union all select row_to_json(f)::text from auth_flow f
                    union all select row_to_json(t)::text from setup_token t`,
            );
            invariant(rows.ok, "the token tables are readable");
            const dump = rows.value.map((entry) => entry.row).join("\n");
            const hex = toHex;
            for (const token of [alice.sessionToken, link.setupToken, flow.value.flowToken]) {
                expect(dump).not.toContain(token);
                expect(dump).not.toContain(hex(new TextEncoder().encode(token)));
                expect(dump).toContain(hex(await hashToken(token)));
            }
        });
    });
});

describe("credential changes", () => {
    test("a sign-in older than five minutes can't change credentials until a passkey step-up", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(311);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "all" });
            invariant(alice.passkey !== null, "alice has a passkey");
            const tokenHash = await hashToken(alice.sessionToken);
            await execute(
                nativeDb,
                sql`update browser_session set authenticated_at = now() - interval '6 minutes'
                    where token_hash = ${tokenHash}`,
            );
            const change = () =>
                setPassword(deps, {
                    sessionToken: alice.sessionToken,
                    password: "an entirely new passphrase",
                });
            expect(await change()).toEqual(err({ code: "REAUTH_REQUIRED", withinSeconds: 300 }));

            const begun = await beginStepUp(deps, { sessionToken: alice.sessionToken });
            invariant(begun.ok, "alice can step up with her passkey");
            const stepped = await finishStepUp(deps, {
                sessionToken: alice.sessionToken,
                flowToken: begun.value.flowToken,
                response: AuthenticationResponse.parse(
                    await alice.passkey.assert(begun.value.options),
                ),
            });
            expect(stepped.ok).toBe(true);
            expect(await change()).toEqual(ok(undefined));
        });
    });

    test("an account with only a password and TOTP can't step up", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(312);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            expect(await beginStepUp(deps, { sessionToken: alice.sessionToken })).toEqual(
                err({ code: "NO_PASSKEY" }),
            );
        });
    });

    test("a passkey step-up is what lets a step-up action through", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(313);
            const deps = await createTestAuthDeps(browserDb, rng);
            const rootId = await seedRootOnce(browserDb, rng);
            const session = await memberSession(deps, rootId);
            const create = async () => {
                const resolved = await resolveViewer(browserDb, {
                    sessionToken: session,
                    client: null,
                });
                invariant(resolved.ok, "the root's session resolves");
                return await createAccount({
                    db: browserDb,
                    rng,
                    caller: { accountId: rootId, stepUpAt: resolved.value.stepUpAt, client: null },
                    operationId: newOperationId(rng),
                    email: `staff${rng.nextUint32()}@lucent.test`,
                });
            };
            expect(await create()).toEqual(
                err({ code: "STEP_UP_REQUIRED", withinSeconds: STEP_UP_WINDOW_SECONDS }),
            );

            const passkey = await createTestAuthenticator({ rng });
            await registerPasskey(deps, session, passkey);
            const begun = await beginStepUp(deps, { sessionToken: session });
            invariant(begun.ok, "the root has a passkey now");
            const stepped = await finishStepUp(deps, {
                sessionToken: session,
                flowToken: begun.value.flowToken,
                response: AuthenticationResponse.parse(await passkey.assert(begun.value.options)),
            });
            expect(stepped.ok).toBe(true);
            expect((await create()).ok).toBe(true);
        });
    });

    test("a credential change signs out every other session of the account", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(314);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "all" });
            const elsewhere = await memberSession(deps, alice.accountId);
            const changed = await setPassword(deps, {
                sessionToken: alice.sessionToken,
                password: "an entirely new passphrase",
            });
            expect(changed).toEqual(ok(undefined));
            expect(
                await resolveViewer(browserDb, { sessionToken: elsewhere, client: null }),
            ).toEqual(err({ code: "SESSION_INVALID" }));
            expect(
                (await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: null }))
                    .ok,
            ).toBe(true);
        });
    });
});

describe("the last way in", () => {
    test("neither an only passkey nor half of password-and-TOTP can be removed", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(321);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            invariant(alice.passkey !== null, "alice has a passkey");
            expect(
                await removeCredential(deps, {
                    sessionToken: alice.sessionToken,
                    credential: { kind: "passkey", id: alice.passkey.credentialId },
                }),
            ).toEqual(err({ code: "LAST_CREDENTIAL" }));

            const bob = await newMember(deps, rng, { username: "bob", with: "password+totp" });
            for (const kind of ["totp", "password"] as const) {
                expect(
                    await removeCredential(deps, {
                        sessionToken: bob.sessionToken,
                        credential: { kind },
                    }),
                ).toEqual(err({ code: "LAST_CREDENTIAL" }));
            }

            const carol = await newMember(deps, rng, { username: "carol", with: "all" });
            expect(
                await removeCredential(deps, {
                    sessionToken: carol.sessionToken,
                    credential: { kind: "totp" },
                }),
            ).toEqual(ok(undefined));
        });
    });

    test("two removals that would together strand the account: exactly one is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(322);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            const passkey = alice.passkey;
            invariant(passkey !== null, "alice has a passkey");
            const second = await createTestAuthenticator({ rng });
            await registerPasskey(deps, alice.sessionToken, second);

            // Both removals park on the account lock before either runs, so they really race.
            let racing: ReturnType<typeof removeCredential>[] = [];
            let parked = false;
            const gate = await withTx(nativeDb, async (tx) => {
                const held = await execute(
                    tx,
                    sql`select id from account where id = ${alice.accountId} for update`,
                );
                expect(held).toEqual(ok(1));
                racing = [passkey.credentialId, second.credentialId].map((id) =>
                    removeCredential(deps, {
                        sessionToken: alice.sessionToken,
                        credential: { kind: "passkey", id },
                    }),
                );
                parked = await waitForLockWaiters(nativeDb, 2);
                return ok(undefined);
            });
            const outcomes = await Promise.all(racing);
            expect(gate.ok).toBe(true);
            expect(parked).toBe(true);
            expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
            expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
                err({ code: "LAST_CREDENTIAL" }),
            ]);
        });
    });

    test("the same authenticator can't be registered twice", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(323);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            const bob = await newMember(deps, rng, { username: "bob", with: "password+totp" });
            const passkey = alice.passkey;
            invariant(passkey !== null, "alice has a passkey");
            const begun = await beginPasskeyRegistration(deps, { sessionToken: bob.sessionToken });
            invariant(begun.ok, "bob can register a passkey");
            expect(
                await finishPasskeyRegistration(deps, {
                    sessionToken: bob.sessionToken,
                    flowToken: begun.value.flowToken,
                    label: "stolen",
                    response: RegistrationResponse.parse(
                        await passkey.register(begun.value.options),
                    ),
                }),
            ).toEqual(err({ code: "PASSKEY_REJECTED" }));
        });
    });
});

describe("setup links", () => {
    test("a setup link works once", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(331);
            const deps = await createTestAuthDeps(browserDb, rng);
            const link = await newSetupLink(deps, rng, "alice@lucent.test");
            expect((await redeemSetupLink(deps, { setupToken: link.setupToken })).ok).toBe(true);
            expect(await redeemSetupLink(deps, { setupToken: link.setupToken })).toEqual(
                err({ code: "SETUP_INVALID" }),
            );
        });
    });

    test("recovery removes every way in and replaces the old setup link", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(332);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "all" });
            const rootId = await seedRootOnce(browserDb, rng);
            const recovered = await recoverAccount({
                db: browserDb,
                rng,
                caller: await steppedUp(browserDb, rootId),
                targetAccountId: alice.accountId,
            });
            invariant(recovered.ok, `recovering alice failed: ${JSON.stringify(recovered)}`);
            expect(
                await resolveViewer(browserDb, { sessionToken: alice.sessionToken, client: null }),
            ).toEqual(err({ code: "SESSION_INVALID" }));
            expect(
                await signInWithPassword(deps, { username: "alice", password: MEMBER_PASSWORD }),
            ).toEqual(err({ code: "INVALID_CREDENTIALS" }));

            const bob = await newSetupLink(deps, rng, "bob@lucent.test");
            const reissued = await recoverAccount({
                db: browserDb,
                rng,
                caller: await steppedUp(browserDb, rootId),
                targetAccountId: bob.accountId,
            });
            invariant(reissued.ok, "recovering bob failed");
            expect(await redeemSetupLink(deps, { setupToken: bob.setupToken })).toEqual(
                err({ code: "SETUP_INVALID" }),
            );
            const fresh = await redeemSetupLink(deps, { setupToken: reissued.value.setupToken });
            expect(fresh.ok && fresh.value.needsUsername).toBe(true);
        });
    });
});
