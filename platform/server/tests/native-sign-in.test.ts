import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { BearerToken, sha256Base64Url, toBase64Url } from "@lucent/core/scalars";
import { z } from "zod";
import { hashToken } from "../src/auth/tokens.ts";
import { execute, sql } from "../src/db/pool.ts";
import { decideSignInRequest, readSignInRequest, SignInRequestId } from "../src/native/sign-in.ts";
import { dbNow, scalar } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createNativeHarness,
    createTestDevice,
    createTestLoader,
    entitledMember,
    REDIRECT_URI,
    refusalCodeOf,
    signIn,
} from "./native-fixtures.ts";

const TokenReply = z.object({ access_token: z.string(), refresh_token: z.string() });

test("a loader signs in through its pushed request, the browser's approval and its PKCE verifier", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_001);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "pkce@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));

        const verifier = toBase64Url(rng.fillBytes(new Uint8Array(32)));
        const pushed = await loader.form("/v1/auth/requests", {
            client_id: "lucent-loader",
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            code_challenge: await sha256Base64Url(verifier),
            code_challenge_method: "S256",
            state: "state-0123456789abcdef",
        });
        expect(pushed.status).toBe(201);
        const { request_uri: requestUri } = z
            .object({ request_uri: z.string(), expires_in: z.literal(600) })
            .parse(pushed.json);
        expect(requestUri).toMatch(/^urn:ietf:params:oauth:request_uri:lauth_[A-Za-z0-9_-]{22}$/);
        const requestId = SignInRequestId.parse(requestUri.split(":").at(-1));

        const shown = await readSignInRequest(nativeDb, {
            sessionToken: member.browserSession,
            requestId,
        });
        invariant(shown.ok, "web reads the pending request");
        expect(shown.value.matchCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

        const decided = await decideSignInRequest(nativeDb, {
            rng,
            sessionToken: member.browserSession,
            requestId,
            decision: "approve",
        });
        invariant(decided.ok, "approving succeeds");
        const callback = new URL(decided.value.redirectTo);
        expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
        const code = callback.searchParams.get("code") ?? "";

        const redeem = (codeVerifier: string) =>
            loader.form("/v1/auth/token", {
                client_id: "lucent-loader",
                grant_type: "authorization_code",
                code,
                code_verifier: codeVerifier,
                redirect_uri: REDIRECT_URI,
            });
        expect(await redeem(toBase64Url(rng.fillBytes(new Uint8Array(32))))).toEqual({
            status: 400,
            json: { error: "invalid_grant" },
        });
        const redeemed = await redeem(verifier);
        expect(redeemed.status).toBe(200);
        expect(redeemed.json).toMatchObject({ token_type: "DPoP", expires_in: 300 });

        // The same code again: one of its two presenters isn't the loader, so what it bought ends.
        expect((await redeem(verifier)).json).toEqual({ error: "invalid_grant" });
        const revoked = await scalar(
            nativeDb,
            z.boolean(),
            sql`select revoked_at is not null as value from native_token_family`,
        );
        expect(revoked).toBe(true);
    });
});

test("a code is redeemed only with the key that pushed the request", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_002);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "bound@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        const thief = createTestLoader(harness, await createTestDevice(rng));
        const verifier = toBase64Url(rng.fillBytes(new Uint8Array(32)));
        const pushed = await loader.form("/v1/auth/requests", {
            client_id: "lucent-loader",
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            code_challenge: await sha256Base64Url(verifier),
            code_challenge_method: "S256",
            state: "state-0123456789abcdef",
        });
        const requestUri = z.object({ request_uri: z.string() }).parse(pushed.json).request_uri;
        const decided = await decideSignInRequest(nativeDb, {
            rng,
            sessionToken: member.browserSession,
            requestId: SignInRequestId.parse(requestUri.split(":").at(-1)),
            decision: "approve",
        });
        invariant(decided.ok, "approving succeeds");
        const stolen = await thief.form("/v1/auth/token", {
            client_id: "lucent-loader",
            grant_type: "authorization_code",
            code: new URL(decided.value.redirectTo).searchParams.get("code") ?? "",
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
        });
        expect(stolen).toEqual({ status: 400, json: { error: "invalid_grant" } });
    });
});

test("a denied request sends the browser back with access_denied and never yields a code", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_003);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "deny@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        const pushed = await loader.form("/v1/auth/requests", {
            client_id: "lucent-loader",
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            code_challenge: "c".repeat(43),
            code_challenge_method: "S256",
            state: "state-0123456789abcdef",
        });
        const requestId = SignInRequestId.parse(
            z.object({ request_uri: z.string() }).parse(pushed.json).request_uri.split(":").at(-1),
        );
        const denied = await decideSignInRequest(nativeDb, {
            rng,
            sessionToken: member.browserSession,
            requestId,
            decision: "deny",
        });
        invariant(denied.ok, "denying succeeds");
        expect(new URL(denied.value.redirectTo).searchParams.get("error")).toBe("access_denied");
        expect(
            await decideSignInRequest(nativeDb, {
                rng,
                sessionToken: member.browserSession,
                requestId,
                decision: "approve",
            }),
        ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    });
});

test("a pushed request refuses any redirect but the loopback IP literal", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_004);
        const harness = await createNativeHarness(nativeDb, rng);
        const loader = createTestLoader(harness, await createTestDevice(rng));
        for (const redirect of [
            "http://localhost:53682/callback",
            "https://evil.example/callback",
            "http://127.0.0.1:80/callback",
            "http://127.0.0.1:53682/other",
        ]) {
            const pushed = await loader.form("/v1/auth/requests", {
                client_id: "lucent-loader",
                response_type: "code",
                redirect_uri: redirect,
                code_challenge: "c".repeat(43),
                code_challenge_method: "S256",
                state: "state-0123456789abcdef",
            });
            expect({ redirect, pushed }).toEqual({
                redirect,
                pushed: { status: 400, json: { error: "invalid_request" } },
            });
        }
    });
});

test("a refresh token rotates, a lost reply may be retried within 30 seconds, and reuse after that revokes the family", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_005);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "rotate@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        await signIn(harness, loader, member.browserSession);
        const refresh = (token: string) =>
            loader.form("/v1/auth/token", {
                client_id: "lucent-loader",
                grant_type: "refresh_token",
                refresh_token: token,
            });

        const first = loader.refreshToken();
        const second = TokenReply.parse((await refresh(first)).json);
        expect(second.refresh_token).not.toBe(first);

        // The reply was lost: the same token again, within the grace, gets a working pair in place
        // of the one whose reply never arrived.
        const retried = TokenReply.parse((await refresh(first)).json);
        expect(retried.refresh_token).not.toBe(second.refresh_token);
        const third = TokenReply.parse((await refresh(retried.refresh_token)).json);

        // Thirty seconds on, the first token is a copy in other hands.
        await execute(
            nativeDb,
            sql`update native_refresh_token set rotated_at = rotated_at - interval '31 seconds'
                where token_hash = ${await hashToken(BearerToken.parse(first))}`,
        );
        expect(await refresh(first)).toEqual({ status: 400, json: { error: "invalid_grant" } });
        expect(await refresh(third.refresh_token)).toEqual({
            status: 400,
            json: { error: "invalid_grant" },
        });
        loader.useTokens({ access: third.access_token, refresh: third.refresh_token });
        const afterRevoke = await loader.send({
            method: "GET",
            path: `/v1/enrollments/${"0".repeat(32)}`,
        });
        expect(refusalCodeOf(afterRevoke)).toBe("AUTH_REQUIRED");
    });
});

test("a refresh token presented again after its successor was used revokes the family at once", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_006);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "reuse@lucent.test",
            channels: ["alpha"],
        });
        const loader = createTestLoader(harness, await createTestDevice(rng));
        await signIn(harness, loader, member.browserSession);
        const refresh = (token: string) =>
            loader.form("/v1/auth/token", {
                client_id: "lucent-loader",
                grant_type: "refresh_token",
                refresh_token: token,
            });
        const first = loader.refreshToken();
        const second = TokenReply.parse((await refresh(first)).json);
        const third = TokenReply.parse((await refresh(second.refresh_token)).json);
        expect((await refresh(first)).json).toEqual({ error: "invalid_grant" });
        expect((await refresh(third.refresh_token)).json).toEqual({ error: "invalid_grant" });
    });
});

test("a DPoP proof is accepted once, and only within 5 seconds ahead and 300 behind the server's clock", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_007);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "dpop@lucent.test",
            channels: ["alpha"],
        });
        const device = await createTestDevice(rng);
        const loader = createTestLoader(harness, device);
        await signIn(harness, loader, member.browserSession);
        const path = `/v1/enrollments/${"0".repeat(32)}`;
        const now = Math.floor((await dbNow(nativeDb)) / 1_000);

        const send = async (proof: string) => {
            const res = await harness.fetch(
                new Request(`http://127.0.0.1:4711${path}`, {
                    headers: { authorization: `DPoP ${loader.accessToken()}`, dpop: proof },
                }),
            );
            return refusalCodeOf({
                status: res.status,
                bytes: new Uint8Array(await res.arrayBuffer()),
            });
        };
        const proofAt = (iat: number) =>
            device.proof({ method: "GET", path, accessToken: loader.accessToken(), iat });

        // NOT_FOUND: the proof passed and the enrollment simply doesn't exist.
        const fresh = await proofAt(now);
        expect(await send(fresh)).toBe("NOT_FOUND");
        expect(await send(fresh)).toBe("PROOF_INVALID");
        expect(await send(await proofAt(now + 60))).toBe("PROOF_INVALID");
        expect(await send(await proofAt(now - 400))).toBe("PROOF_INVALID");
        expect(await send(await proofAt(now + 2))).toBe("NOT_FOUND");
        expect(await send(await proofAt(now - 250))).toBe("NOT_FOUND");
    });
});

test("a proof must name this request and this token, and the token only works with its own key", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ nativeDb }) => {
        const rng = createSeededRng(9_008);
        const harness = await createNativeHarness(nativeDb, rng);
        const member = await entitledMember(harness, {
            email: "bind@lucent.test",
            channels: ["alpha"],
        });
        const device = await createTestDevice(rng);
        const loader = createTestLoader(harness, device);
        await signIn(harness, loader, member.browserSession);
        const path = `/v1/enrollments/${"0".repeat(32)}`;
        const send = async (proof: string) => {
            const res = await harness.fetch(
                new Request(`http://127.0.0.1:4711${path}`, {
                    headers: { authorization: `DPoP ${loader.accessToken()}`, dpop: proof },
                }),
            );
            return refusalCodeOf({
                status: res.status,
                bytes: new Uint8Array(await res.arrayBuffer()),
            });
        };
        const token = loader.accessToken();
        expect(await send(await device.proof({ method: "POST", path, accessToken: token }))).toBe(
            "PROOF_INVALID",
        );
        expect(
            await send(
                await device.proof({ method: "GET", path: "/v1/starts", accessToken: token }),
            ),
        ).toBe("PROOF_INVALID");
        expect(
            await send(await device.proof({ method: "GET", path, accessToken: "x".repeat(43) })),
        ).toBe("PROOF_INVALID");
        expect(await send(await device.proof({ method: "GET", path }))).toBe("PROOF_INVALID");
        const other = await createTestDevice(rng);
        expect(await send(await other.proof({ method: "GET", path, accessToken: token }))).toBe(
            "AUTH_REQUIRED",
        );
        expect(await send(await device.proof({ method: "GET", path, accessToken: token }))).toBe(
            "NOT_FOUND",
        );
    });
});
