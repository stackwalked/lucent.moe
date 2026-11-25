import { describe, expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { AuthenticationResponse } from "@lucent/rpc/webauthn";
import { TEST_RELYING_PARTY } from "@lucent/testing/authenticator";
import { createAuthDeps } from "../src/auth/deps.ts";
import { createArgon2idHasher } from "../src/auth/password.ts";
import {
    beginPasskeySignIn,
    finishPasskeySignIn,
    signInWithPassword,
    signInWithTotp,
} from "../src/auth/sign-in.ts";
import { createTotpKeyring } from "../src/auth/totp.ts";
import { resolveCaller, resolveViewer } from "../src/auth/viewer.ts";
import { execute, sql } from "../src/db/pool.ts";
import { createEmailHasher } from "../src/deletion/email-hash.ts";
import { codeAt, MEMBER_PASSWORD, newMember } from "./auth-fixtures.ts";
import { createTestAuthDeps, NEVER_BREACHED, TEST_TOTP_KEYS } from "./harness/auth.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

describe("password and TOTP", () => {
    test("an unknown username and a wrong password are refused alike, after one password check each", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(201);
            const hasher = createArgon2idHasher({ memoryCostKiB: 64, timeCost: 1 });
            let verifications = 0;
            const deps = createAuthDeps({
                db: browserDb,
                rng,
                rp: TEST_RELYING_PARTY,
                totpKeys: await createTotpKeyring(TEST_TOTP_KEYS),
                emailHasher: await createEmailHasher(TEST_TOTP_KEYS),
                breachCheck: NEVER_BREACHED,
                mailEnabled: true,
                passwords: {
                    hash: hasher.hash,
                    verify: (password, hash) => {
                        verifications += 1;
                        return hasher.verify(password, hash);
                    },
                },
            });
            await newMember(deps, rng, { username: "alice", with: "password+totp" });

            verifications = 0;
            const unknown = await signInWithPassword(deps, {
                username: "nobody",
                password: MEMBER_PASSWORD,
            });
            expect(verifications).toBe(1);
            verifications = 0;
            const wrong = await signInWithPassword(deps, {
                username: "alice",
                password: "not the password at all",
            });
            expect(verifications).toBe(1);
            expect(unknown).toEqual(err({ code: "INVALID_CREDENTIALS" }));
            expect(wrong).toEqual(unknown);
        });
    });

    test("a password alone opens a flow; only the second factor signs in", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(202);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            invariant(alice.totpSecret !== null, "alice has TOTP");

            const flow = await signInWithPassword(deps, {
                username: "ALICE ",
                password: MEMBER_PASSWORD,
            });
            invariant(flow.ok && flow.value.next === "secondFactor", "the password is right");
            expect(flow.value.secondFactors).toEqual(["totp"]);
            const signedIn = await signInWithTotp(deps, {
                flowToken: flow.value.flowToken,
                code: await codeAt(browserDb, alice.totpSecret, 1),
            });
            invariant(signedIn.ok, `the code is right: ${JSON.stringify(signedIn)}`);
            const session = await resolveViewer(browserDb, {
                sessionToken: signedIn.value.sessionToken,
                client: null,
            });
            expect(session.ok && session.value.purpose).toBe("member");
        });
    });

    test("a TOTP code is accepted once, and never one older than the last accepted", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(203);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            invariant(alice.totpSecret !== null, "alice has TOTP");
            const attempt = async (code: string) => {
                const flow = await signInWithPassword(deps, {
                    username: "alice",
                    password: MEMBER_PASSWORD,
                });
                invariant(flow.ok && flow.value.next === "secondFactor", "the password is right");
                return await signInWithTotp(deps, { flowToken: flow.value.flowToken, code });
            };

            // Enrollment spent the current step's code.
            const enrolled = await codeAt(browserDb, alice.totpSecret, 0);
            expect(await attempt(enrolled)).toEqual(err({ code: "INVALID_CREDENTIALS" }));
            const next = await codeAt(browserDb, alice.totpSecret, 1);
            expect((await attempt(next)).ok).toBe(true);
            expect(await attempt(next)).toEqual(err({ code: "INVALID_CREDENTIALS" }));
            const previous = await codeAt(browserDb, alice.totpSecret, -1);
            expect(await attempt(previous)).toEqual(err({ code: "INVALID_CREDENTIALS" }));
        });
    });

    test("a sign-in flow dies after five wrong codes, even for the right sixth", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(204);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            invariant(alice.totpSecret !== null, "alice has TOTP");
            const flow = await signInWithPassword(deps, {
                username: "alice",
                password: MEMBER_PASSWORD,
            });
            invariant(flow.ok && flow.value.next === "secondFactor", "the password is right");
            const right = await codeAt(browserDb, alice.totpSecret, 1);
            const wrong = right === "000000" ? "000001" : "000000";
            for (let i = 0; i < 5; i++) {
                expect(
                    await signInWithTotp(deps, { flowToken: flow.value.flowToken, code: wrong }),
                ).toEqual(err({ code: "INVALID_CREDENTIALS" }));
            }
            expect(
                await signInWithTotp(deps, { flowToken: flow.value.flowToken, code: right }),
            ).toEqual(err({ code: "FLOW_INVALID" }));
        });
    });

    test("a suspended account passes every factor and gets only an appeal session", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(205);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            invariant(alice.totpSecret !== null, "alice has TOTP");
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${alice.accountId}`,
            );
            const flow = await signInWithPassword(deps, {
                username: "alice",
                password: MEMBER_PASSWORD,
            });
            invariant(flow.ok && flow.value.next === "secondFactor", "the password is right");
            const signedIn = await signInWithTotp(deps, {
                flowToken: flow.value.flowToken,
                code: await codeAt(browserDb, alice.totpSecret, 1),
            });
            invariant(signedIn.ok, `every factor passed: ${JSON.stringify(signedIn)}`);
            expect(signedIn.value.purpose).toBe("appeal");
            const sessionToken = signedIn.value.sessionToken;
            const viewer = await resolveViewer(browserDb, { sessionToken, client: null });
            expect(viewer.ok && viewer.value.purpose).toBe("appeal");
            expect(viewer.ok && viewer.value.standing.permissions).toEqual([]);
            expect(await resolveCaller(browserDb, { sessionToken, client: null })).toEqual(
                err({ code: "SESSION_INVALID" }),
            );
        });
    });

    test("a suspended account signing in on a password alone gets no session at all", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb, nativeDb }) => {
            const rng = createSeededRng(206);
            const deps = { ...(await createTestAuthDeps(browserDb, rng)), passwordOnly: true };
            const alice = await newMember(deps, rng, { username: "alice", with: "password+totp" });
            await execute(
                nativeDb,
                sql`update account set status = 'suspended' where id = ${alice.accountId}`,
            );
            expect(
                await signInWithPassword(deps, { username: "alice", password: MEMBER_PASSWORD }),
            ).toEqual(err({ code: "ACCOUNT_UNAVAILABLE" }));
        });
    });
});

describe("passkeys", () => {
    test("a passkey alone signs in, and its challenge answers only once", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(211);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            invariant(alice.passkey !== null, "alice has a passkey");

            const begun = await beginPasskeySignIn(deps, { flowToken: null });
            invariant(begun.ok, "a passkey sign-in starts for anyone");
            const response = AuthenticationResponse.parse(
                await alice.passkey.assert(begun.value.options),
            );
            const first = await finishPasskeySignIn(deps, {
                flowToken: begun.value.flowToken,
                response,
            });
            expect(first.ok).toBe(true);
            expect(
                await finishPasskeySignIn(deps, { flowToken: begun.value.flowToken, response }),
            ).toEqual(err({ code: "FLOW_INVALID" }));
        });
    });

    test("an assertion made for another origin is refused", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(212);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            invariant(alice.passkey !== null, "alice has a passkey");
            const begun = await beginPasskeySignIn(deps, { flowToken: null });
            invariant(begun.ok, "a passkey sign-in starts for anyone");
            const phished = await alice.passkey.assert(begun.value.options, {
                origin: "https://lucent-login.example",
            });
            expect(
                await finishPasskeySignIn(deps, {
                    flowToken: begun.value.flowToken,
                    response: AuthenticationResponse.parse(phished),
                }),
            ).toEqual(err({ code: "PASSKEY_REJECTED" }));
        });
    });

    test("a passkey whose counter goes backwards is refused as a clone", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(213);
            const deps = await createTestAuthDeps(browserDb, rng);
            const alice = await newMember(deps, rng, { username: "alice", with: "passkey" });
            const passkey = alice.passkey;
            invariant(passkey !== null, "alice has a passkey");
            const signIn = async (signCount: number) => {
                const begun = await beginPasskeySignIn(deps, { flowToken: null });
                invariant(begun.ok, "a passkey sign-in starts for anyone");
                const response = await passkey.assert(begun.value.options, { signCount });
                return await finishPasskeySignIn(deps, {
                    flowToken: begun.value.flowToken,
                    response: AuthenticationResponse.parse(response),
                });
            };
            expect((await signIn(5)).ok).toBe(true);
            expect(await signIn(3)).toEqual(err({ code: "PASSKEY_REJECTED" }));
        });
    });

    test("a password flow can't be finished with another account's passkey", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(214);
            const deps = await createTestAuthDeps(browserDb, rng);
            await newMember(deps, rng, { username: "alice", with: "all" });
            const mallory = await newMember(deps, rng, { username: "mallory", with: "passkey" });
            invariant(mallory.passkey !== null, "mallory has a passkey");

            const flow = await signInWithPassword(deps, {
                username: "alice",
                password: MEMBER_PASSWORD,
            });
            invariant(flow.ok && flow.value.next === "secondFactor", "alice's password is right");
            expect(flow.value.secondFactors).toEqual(["totp", "passkey"]);
            const begun = await beginPasskeySignIn(deps, { flowToken: flow.value.flowToken });
            invariant(begun.ok, "alice has a passkey to finish with");
            const response = await mallory.passkey.assert(begun.value.options);
            expect(
                await finishPasskeySignIn(deps, {
                    flowToken: flow.value.flowToken,
                    response: AuthenticationResponse.parse(response),
                }),
            ).toEqual(err({ code: "PASSKEY_REJECTED" }));
        });
    });
});

describe("a dev server with passwordOnly", () => {
    test("signs in on the password alone and counts every step-up as just made", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ browserDb }) => {
            const rng = createSeededRng(220);
            const deps = { ...(await createTestAuthDeps(browserDb, rng)), passwordOnly: true };
            await newMember(deps, rng, { username: "alice", with: "password+totp" });

            const signedIn = await signInWithPassword(deps, {
                username: "alice",
                password: MEMBER_PASSWORD,
            });
            invariant(signedIn.ok && signedIn.value.next === "signedIn", "no second step");
            const params = { sessionToken: signedIn.value.sessionToken, client: null };
            const caller = await resolveCaller(browserDb, { ...params, stepUpWaived: true });
            expect(caller.ok && caller.value.stepUpAt !== null).toBe(true);
            const plain = await resolveCaller(browserDb, params);
            expect(plain.ok && plain.value.stepUpAt).toBeNull();
            expect(
                await signInWithPassword(deps, { username: "alice", password: "not it at all" }),
            ).toEqual(err({ code: "INVALID_CREDENTIALS" }));
        });
    });
});
