import { expect, test } from "bun:test";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { newOperationId, sha256Base64Url, toBase64Url, toHex } from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { webContract } from "@lucent/rpc/web";
import { TEST_RELYING_PARTY } from "@lucent/testing/authenticator";
import { WORKSPACE_ROOT } from "@lucent/testing/postgres";
import { parseEnrollmentStatus, toEnrollmentRequestBytes } from "@lucent/wire/enrollment";
import { z } from "zod";
import { matchCodeOf } from "../src/base/core/ids.ts";
import { openPool } from "../src/base/db/pool.ts";
import { startServer } from "../src/boot.ts";
import { createLeaseSigner } from "../src/delivery/runtime/lease-key.ts";
import { catalog } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";
import {
    createTestDevice,
    createTestLoader,
    createTestModule,
    decryptContainer,
    entitledMember,
    LEASE_SEED,
    ORIGIN,
    OVERRIDE_SEED,
    publishRelease,
    REDIRECT_URI,
    refusalCodeOf,
    sessionPath,
    startOk,
} from "./native-fixtures.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";

// The whole native path against a booted server, over HTTP on both listeners: the loader signs in
// and enrolls with the member approving each step through web's procedures, starts, downloads
// and opens its container, relays the module's hello and renewals, and closes. @lucent/wire plays
// the loader and the module byte for byte.
test("a member's PC signs in, enrolls, starts, holds a lease and closes, end to end", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ databaseUrl }) => {
        const rng = createSeededRng(9_401);
        const started = await startServer({
            config: {
                databaseUrl,
                internalListen: { kind: "loopback", hostname: "127.0.0.1", port: 0 },
                webInternalKey: PEER_KEY,
                productsDir: join(WORKSPACE_ROOT, "products"),
                totpKeys: [{ kid: "test", raw: new Uint8Array(32) }],
                relyingParty: TEST_RELYING_PARTY,
                passwordOnly: false,
                pwnedPasswordsUrl: "http://127.0.0.1:9/range/",
                native: {
                    listen: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
                    origin: ORIGIN,
                    leaseSigningSeed: LEASE_SEED,
                    overrideSigningSeed: OVERRIDE_SEED,
                    artifactDir: "unused-artifact-dir",
                },
            },
            logger: { write: () => {} },
        });
        invariant(started.ok, `boot failed: ${JSON.stringify(started)}`);
        const server = started.value;
        const nativeAddress = server.nativeAddress;
        invariant(nativeAddress !== null, "the native listener is up");
        const seeding = openPool({ databaseUrl, maxConnections: 2 });
        const web = createRpcClient(webContract, {
            endpointUrl: `${server.internalAddress}/internal/web/rpc`,
            peerKey: PEER_KEY,
        });

        const harness = {
            db: seeding,
            rng,
            catalog: catalog(),
            signer: await createLeaseSigner(LEASE_SEED),
            fetch: async (req: Request) =>
                await fetch(new Request(`${nativeAddress}${new URL(req.url).pathname}`, req), {
                    signal: AbortSignal.timeout(5_000),
                }),
        };
        const container = rng.fillBytes(new Uint8Array(150_000));
        const loaderRelease = await publishRelease(seeding, rng, {
            product: "lucent-loader",
            channel: "stable",
        });
        const moduleRelease = await publishRelease(seeding, rng, {
            product: "cs2",
            channel: "alpha",
            container,
        });
        const member = await entitledMember(harness, {
            email: "flow@lucent.test",
            channels: ["alpha"],
        });
        const session = member.browserSession;
        const loader = createTestLoader(harness, await createTestDevice(rng));

        // Sign-in: pushed request, the browser's approval through web, the code on loopback.
        const verifier = toBase64Url(rng.fillBytes(new Uint8Array(32)));
        const pushed = await loader.form("/v1/auth/requests", {
            client_id: "lucent-loader",
            response_type: "code",
            redirect_uri: REDIRECT_URI,
            code_challenge: await sha256Base64Url(verifier),
            code_challenge_method: "S256",
            state: "flow-state-0123456789",
        });
        const requestId =
            z
                .object({ request_uri: z.string() })
                .parse(pushed.json)
                .request_uri.split(":")
                .at(-1) ?? "";
        const shown = await web.call("devices.signIn.read", { requestId }, { session });
        expect(shown.ok && shown.value.matchCode).toBe(matchCodeOf(loader.device.jkt));
        const approved = await web.call("devices.signIn.approve", { requestId }, { session });
        invariant(approved.ok, `approval failed: ${JSON.stringify(approved)}`);
        const code = new URL(approved.value.redirectTo).searchParams.get("code") ?? "";
        const tokens = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(
            (
                await loader.form("/v1/auth/token", {
                    client_id: "lucent-loader",
                    grant_type: "authorization_code",
                    code,
                    code_verifier: verifier,
                    redirect_uri: REDIRECT_URI,
                })
            ).json,
        );
        loader.useTokens({ access: tokens.access_token, refresh: tokens.refresh_token });

        // Enrollment: the loader asks, the member matches the code in the browser, the loader polls.
        const requested = await loader.send({
            method: "POST",
            path: "/v1/enrollments",
            body: toEnrollmentRequestBytes({ storage: "tpm" }),
        });
        const pending = parseEnrollmentStatus(requested.bytes);
        invariant(pending.ok, `enrollment refused: ${refusalCodeOf(requested)}`);
        const listed = await web.call("devices.enrollments.list", {}, { session });
        invariant(listed.ok && listed.value.enrollments[0] !== undefined, "one pending enrollment");
        expect(listed.value.enrollments[0].matchCode).toBe(matchCodeOf(loader.device.jkt));
        const confirmed = await web.call(
            "devices.enrollments.approve",
            {
                operationId: newOperationId(rng),
                enrollmentId: listed.value.enrollments[0].enrollmentId,
            },
            { session },
        );
        invariant(confirmed.ok, `confirmation failed: ${JSON.stringify(confirmed)}`);
        const polled = parseEnrollmentStatus(
            (
                await loader.send({
                    method: "GET",
                    path: `/v1/enrollments/${toHex(pending.value.enrollment)}`,
                })
            ).bytes,
        );
        expect(polled.ok && polled.value.state === "approved" && toHex(polled.value.device)).toBe(
            confirmed.value.deviceId,
        );

        // Start, then the container this start's key opens.
        const start = await startOk(loader, { loader: loaderRelease, module: moduleRelease });
        const downloaded = await loader.send({ method: "GET", path: `${start.path}/container` });
        expect(decryptContainer(start.containerKey, downloaded.bytes)).toEqual(container);

        // The module's hello, relayed; the exchange and every lease verified as the module does.
        const module = createTestModule(rng, harness.signer.publicKey);
        const opened = await loader.send({
            method: "POST",
            path: `${start.path}/session`,
            body: await module.hello(moduleRelease.id),
        });
        expect(opened.status).toBe(200);
        const first = await module.acceptSession(opened.bytes);
        expect(toHex(first.device)).toBe(confirmed.value.deviceId);
        expect(first.entitled).toEqual({ everything: true });

        const path = sessionPath(module.session());
        let loaderAnswer: Uint8Array | null = null;
        for (const expected of [2n, 3n]) {
            const renewed = await loader.send({
                method: "POST",
                path: `${path}/lease`,
                body: module.renewal({ loaderAnswer }),
            });
            expect(renewed.status).toBe(200);
            expect((await module.acceptLease(renewed.bytes)).sequence).toBe(expected);
            loaderAnswer = rng.fillBytes(new Uint8Array(32));
        }

        const closed = await loader.send({
            method: "POST",
            path: `${path}/close`,
            operationId: null,
        });
        expect(closed.status).toBe(204);
        const after = await loader.send({
            method: "POST",
            path: `${path}/lease`,
            body: module.renewal({ loaderAnswer }),
        });
        expect(refusalCodeOf(after)).toBe("SESSION_ENDED");

        await seeding.close();
        await server.stop();
    });
});
