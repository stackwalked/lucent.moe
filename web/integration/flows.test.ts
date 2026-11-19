import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs, newOperationId } from "@lucent/core/scalars";
import { CreationOptions, RequestOptions } from "@lucent/rpc/webauthn";
import { createTestAuthenticator, type TestAuthenticator } from "@lucent/testing/authenticator";
import { type RunningPlatform, startPlatform } from "@lucent/testing/platform";
import {
    allocateEphemeralPort,
    sharedEphemeralCluster,
    shutdownSharedEphemeralCluster,
} from "@lucent/testing/postgres";
import { type ChildServer, spawnServer } from "@lucent/testing/process";
import { totpCodeAt } from "@lucent/testing/totp";
import { SQL } from "bun";
import { z } from "zod";
import { accepted, createTestBrowser, refusedCode, type TestBrowser } from "./browser.ts";

// The flows that cross both processes and live in cookies, run against the production build of web
// (web:build) and platform as an operator starts it, each in its own process. One stack serves the
// file, so the tests run in order: root is set up first and signs in after.

const WEB_DIR = join(import.meta.dir, "..");
const PASSWORD = "integration passphrase 2026";
const SESSION_COOKIE = "__Host-lucent";

const fn = {
    setupLinkWaiting: "features.setup.server--setupLinkWaiting",
    redeemSetup: "features.setup.server--redeemSetup",
    finishSetup: "features.setup.server--finishSetup",
    setPassword: "features.credentials.server--setPassword",
    enrollTotp: "features.credentials.server--enrollTotp",
    confirmTotp: "features.credentials.server--confirmTotp",
    beginPasskeyRegistration: "features.credentials.server--beginPasskeyRegistration",
    finishPasskeyRegistration: "features.credentials.server--finishPasskeyRegistration",
    beginStepUp: "features.credentials.server--beginStepUp",
    finishStepUp: "features.credentials.server--finishStepUp",
    signInWithPassword: "features.auth.sign-in-server--signInWithPassword",
    signInWithCode: "features.auth.sign-in-server--signInWithCode",
    beginPasskey: "features.auth.sign-in-server--beginPasskey",
    finishPasskey: "features.auth.sign-in-server--finishPasskey",
    createAccount: "features.admin.accounts.server--createAccount",
    fetchAccounts: "features.admin.accounts.server--fetchAccounts",
} as const;

let platform: RunningPlatform;
let web: ChildServer;
let origin: string;
let socket: string;
let authenticator: TestAuthenticator;
let totpSecret: string;
// Signed in by a passkey and carried through the later flows: web lets an address make ten sign-in
// calls a minute, and one sign-in per test would spend them.
let member: TestBrowser;

const browser = (): TestBrowser => createTestBrowser({ socket, origin });
const codeIn = (steps: number) =>
    totpCodeAt(totpSecret, EpochMs.parse(systemClock.now() + steps * 30_000));

beforeAll(async () => {
    const port = allocateEphemeralPort();
    origin = `http://localhost:${port}`;
    socket = `http://127.0.0.1:${port}`;
    platform = await startPlatform({
        cluster: await sharedEphemeralCluster(),
        database: "web_flows",
        webOrigin: origin,
    });
    web = spawnServer({
        command: [process.execPath, "src/main.ts"],
        cwd: WEB_DIR,
        env: {
            LUCENT_WEB_LISTEN: `127.0.0.1:${port}`,
            LUCENT_PUBLIC_ORIGIN: origin,
            LUCENT_PLATFORM_INTERNAL_URL: platform.internalUrl,
            LUCENT_WEB_INTERNAL_KEY: platform.peerKey,
        },
    });
    await web.waitFor(/"msg":"listening"/);
    authenticator = await createTestAuthenticator({
        rng: createSeededRng(7001),
        rp: { rpId: "localhost", origin },
    });
}, 60_000);

afterAll(async () => {
    await web.stop();
    await platform.stop();
    await shutdownSharedEphemeralCluster();
});

describe("web against a real platform", () => {
    test("a setup link is stored and redirected, redeemed once, and ends with every credential", async () => {
        const page = browser();
        const link = await page.get(platform.rootSetupPath);
        expect(link.status).toBe(303);
        expect(link.headers.get("location")).toEndWith("/setup");
        expect(await page.read(fn.setupLinkWaiting)).toBe(true);
        accepted(z.null(), await page.call(fn.redeemSetup));
        expect(page.hasCookie(SESSION_COOKIE)).toBe(true);

        accepted(z.null(), await page.call(fn.setPassword, { password: PASSWORD }));
        totpSecret = accepted(
            z.object({ secret: z.string() }),
            await page.call(fn.enrollTotp),
        ).secret;
        accepted(z.null(), await page.call(fn.confirmTotp, { code: await codeIn(0) }));
        const creation = accepted(CreationOptions, await page.call(fn.beginPasskeyRegistration));
        accepted(
            z.string(),
            await page.call(fn.finishPasskeyRegistration, {
                label: "test key",
                response: await authenticator.register(creation),
            }),
        );
        await page.call(fn.finishSetup, { username: "root" });
        expect(page.hasCookie(SESSION_COOKIE)).toBe(false);

        // The link is spent: another browser holding it gets nowhere.
        const late = browser();
        await late.get(platform.rootSetupPath);
        expect(refusedCode(await late.call(fn.redeemSetup))).toBe("SETUP_INVALID");
    });

    test("a password and then an authenticator code sign in", async () => {
        const page = browser();
        const first = accepted(
            z.object({ next: z.literal("secondFactor"), secondFactors: z.array(z.string()) }),
            await page.call(fn.signInWithPassword, { username: "root", password: PASSWORD }),
        );
        expect(first.secondFactors.toSorted()).toEqual(["passkey", "totp"]);
        // The step after the one setup used: each code is accepted once.
        expect(
            accepted(z.string(), await page.call(fn.signInWithCode, { code: await codeIn(1) })),
        ).toBe("/");
        expect((await page.get("/account/security")).status).toBe(200);
    });

    test("a passkey alone signs in", async () => {
        const page = browser();
        const options = accepted(
            RequestOptions,
            await page.call(fn.beginPasskey, { mode: "passkey-only" }),
        );
        const response = await authenticator.assert(options);
        accepted(z.string(), await page.call(fn.finishPasskey, { mode: "passkey-only", response }));
        expect((await page.get("/account/security")).status).toBe(200);
        member = page;
    });

    test("a member page reached with an expired session sends to sign-in, then back to it", async () => {
        const page = member;

        const db = new SQL(platform.databaseUrl);
        // The window check wants expiry after creation: a moment after it, long since passed.
        await db`update browser_session set expires_at = created_at + interval '1 millisecond'`;
        await db.close();

        const sent = await page.get("/account/security");
        expect(sent.status).toBe(303);
        expect(sent.headers.get("location")).toEndWith("/sign-in");
        accepted(
            z.object({ next: z.literal("secondFactor") }),
            await page.call(fn.signInWithPassword, { username: "root", password: PASSWORD }),
        );
        const second = accepted(
            RequestOptions,
            await page.call(fn.beginPasskey, { mode: "second-factor" }),
        );
        const landed = accepted(
            z.string(),
            await page.call(fn.finishPasskey, {
                mode: "second-factor",
                response: await authenticator.assert(second),
            }),
        );
        expect(landed).toBe("/account/security");
    });

    test("a staff action refused for want of a step-up acts once after it, however often it's sent", async () => {
        // Signed in again just now, with no step-up since.
        const page = member;
        const add = {
            operationId: newOperationId(createSeededRng(7002)),
            email: "bob@lucent.test",
        };
        expect(refusedCode(await page.call(fn.createAccount, add))).toBe("STEP_UP_REQUIRED");

        const proof = accepted(RequestOptions, await page.call(fn.beginStepUp));
        accepted(
            z.null(),
            await page.call(fn.finishStepUp, { response: await authenticator.assert(proof) }),
        );
        const Added = z.object({ setupToken: z.string().nullable() });
        expect(accepted(Added, await page.call(fn.createAccount, add)).setupToken).not.toBeNull();
        // The same operation again, as a double submit sends it: platform answers from its receipt.
        expect(accepted(Added, await page.call(fn.createAccount, add)).setupToken).toBeNull();

        const listed = accepted(
            z.object({ items: z.array(z.object({ email: z.string() })) }),
            await page.read(fn.fetchAccounts, {
                status: null,
                roleId: null,
                text: "bob",
                sort: "newest",
                cursor: null,
            }),
        );
        invariant(listed.items.length > 0, "bob was added");
        expect(listed.items.map((item) => item.email)).toEqual(["bob@lucent.test"]);
    });
});
