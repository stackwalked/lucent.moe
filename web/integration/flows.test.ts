import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const BREACHED = "correct horse battery staple";
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
    fetchAccount: "features.admin.accounts.server--fetchAccount",
    issueEntitlement: "features.admin.accounts.server--issueEntitlement",
    landing: "features.auth.session--landing",
    fetchSignInRequest: "features.devices.server--fetchSignInRequest",
    decideSignInRequest: "features.devices.server--decideSignInRequest",
    fetchDevices: "features.devices.server--fetchDevices",
    approveEnrollment: "features.devices.server--approveEnrollment",
    renameDevice: "features.devices.server--renameDevice",
    removeDevice: "features.devices.server--removeDevice",
    fetchProducts: "features.products.server--fetchProducts",
    listReleases: "features.admin.releases.server--listReleases",
    promoteRelease: "features.admin.releases.promote--promoteRelease",
    listFactSets: "features.admin.releases.server--listFactSets",
    promoteFactSet: "features.admin.releases.promote--promoteFactSet",
    fetchLoaderOffer: "features.products.server--fetchLoaderOffer",
} as const;

// A device key's thumbprint as the loader would push it: 32 bytes, here all zero, so its match
// code is the first 40 bits of zero.
const JKT = "A".repeat(43);
const MATCH_CODE = "0000-0000";
const LOOPBACK = "http://127.0.0.1:53682/callback";

let platform: RunningPlatform;
let web: ChildServer;
let origin: string;
let socket: string;
let artifactDir: string;
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
    artifactDir = await mkdtemp(join(tmpdir(), "lucent-web-artifacts-"));
    platform = await startPlatform({
        cluster: await sharedEphemeralCluster(),
        database: "web_flows",
        webOrigin: origin,
        breached: [BREACHED],
        artifactDir,
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
    await rm(artifactDir, { recursive: true, force: true });
    await shutdownSharedEphemeralCluster();
});

describe("web against a real platform", () => {
    test("the signed-out home is the landing: the mark, apply and sign in, and no bar", async () => {
        const home = await browser().get("/");
        expect(home.status).toBe(200);
        const html = await home.text();
        // The bar's wordmark is the only link home.
        expect(html).not.toContain('href="/"');
        expect(html).toContain('href="/apply"');
        expect(html).toContain('href="/sign-in"');
        expect(html).toContain("<svg");
    });

    test("a setup link is stored and redirected, redeemed once, and ends with every credential", async () => {
        const page = browser();
        const link = await page.get(platform.rootSetupPath);
        expect(link.status).toBe(303);
        expect(link.headers.get("location")).toEndWith("/setup");
        expect(await page.read(fn.setupLinkWaiting)).toBe(true);
        accepted(z.null(), await page.call(fn.redeemSetup));
        expect(page.hasCookie(SESSION_COOKIE)).toBe(true);

        expect(refusedCode(await page.call(fn.setPassword, { password: BREACHED }))).toBe(
            "PASSWORD_BREACHED",
        );
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

    test("the public reset page and POSTs use a separate per-ip limit for known and unknown addresses", async () => {
        const page = browser();
        const response = await page.get("/reset-password");
        expect(response.status).toBe(200);
        for (const email of [
            "root@lucent.test",
            "absent@lucent.test",
            "absent@lucent.test",
            "root@lucent.test",
            "root@lucent.test",
        ]) {
            accepted(
                z.null(),
                await page.call("features.auth.reset-server--requestReset", { email }),
            );
        }
        expect(
            refusedCode(
                await page.call("features.auth.reset-server--requestReset", {
                    email: "absent@lucent.test",
                }),
            ),
        ).toBe("THROTTLED");
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

    test("a loader's sign-in link opened signed out comes back after sign-in, then hands the answer to the loader", async () => {
        const requestId = `lauth_${"r".repeat(22)}`;
        const db = new SQL(platform.databaseUrl);
        await db`insert into native_auth_request
                     (id, jkt, redirect_uri, code_challenge, state, created_at, expires_at)
                 values (${requestId}, ${JKT}, ${LOOPBACK}, ${"c".repeat(43)}, ${"s1"},
                         now(), now() + interval '10 minutes')`;
        await db.close();

        const stranger = browser();
        const sent = await stranger.get(`/auth/device/${requestId}`);
        expect(sent.status).toBe(303);
        expect(sent.headers.get("location")).toEndWith("/sign-in");
        expect(await stranger.call(fn.landing)).toBe(`/auth/device/${requestId}`);

        expect((await member.get(`/auth/device/${requestId}`)).status).toBe(200);
        const shown = accepted(
            z.object({ matchCode: z.string(), createdAt: z.number() }),
            await member.read(fn.fetchSignInRequest, { requestId }),
        );
        expect(shown.matchCode).toBe(MATCH_CODE);
        const to = new URL(
            accepted(
                z.string(),
                await member.call(fn.decideSignInRequest, { requestId, decision: "approve" }),
            ),
        );
        expect(`${to.origin}${to.pathname}`).toBe(LOOPBACK);
        expect(to.searchParams.get("state")).toBe("s1");
        expect(to.searchParams.get("code")).not.toBeNull();
        // Answered: there's nothing left to decide.
        expect(refusedCode(await member.read(fn.fetchSignInRequest, { requestId }))).toBe(
            "NOT_FOUND",
        );
    });

    test("a waiting pc is approved after a proof, then renamed and removed, which closes the window", async () => {
        const page = member;
        const db = new SQL(platform.databaseUrl);
        const [root] = await db`select id from account where username = 'root'`;
        const enrollmentId = "e".repeat(32);
        await db`insert into device_enrollment
                     (id, account_id, jkt, public_key, storage, created_at, expires_at)
                 values (decode(${enrollmentId}, 'hex'), ${root.id}, ${JKT}, '{}'::jsonb,
                         'software', now(), now() + interval '10 minutes')`;
        // Proven long enough ago that approving asks again.
        await db`update browser_session set authenticated_at = now() - interval '6 minutes',
                     step_up_at = null`;
        await db.close();

        const Devices = z.object({
            devices: z.array(z.object({ deviceId: z.string(), name: z.string().nullable() })),
            enrollments: z.array(z.object({ enrollmentId: z.string(), matchCode: z.string() })),
            replaceableFrom: z.number().nullable(),
        });
        const waiting = accepted(Devices, await page.read(fn.fetchDevices));
        expect(waiting.enrollments).toEqual([{ enrollmentId, matchCode: MATCH_CODE }]);

        const approve = { operationId: newOperationId(createSeededRng(7003)), enrollmentId };
        expect(refusedCode(await page.call(fn.approveEnrollment, approve))).toBe("REAUTH_REQUIRED");
        const proof = accepted(RequestOptions, await page.call(fn.beginStepUp));
        accepted(
            z.null(),
            await page.call(fn.finishStepUp, { response: await authenticator.assert(proof) }),
        );
        expect(
            accepted(
                z.object({ replaced: z.boolean() }),
                await page.call(fn.approveEnrollment, approve),
            ).replaced,
        ).toBe(false);

        const [device] = accepted(Devices, await page.read(fn.fetchDevices)).devices;
        invariant(device !== undefined, "the approved pc is listed");
        accepted(
            z.null(),
            await page.call(fn.renameDevice, { deviceId: device.deviceId, name: " desk " }),
        );
        expect(accepted(Devices, await page.read(fn.fetchDevices)).devices[0]?.name).toBe("desk");

        accepted(
            z.null(),
            await page.call(fn.removeDevice, {
                operationId: newOperationId(createSeededRng(7004)),
                deviceId: device.deviceId,
            }),
        );
        const after = accepted(Devices, await page.read(fn.fetchDevices));
        expect(after.devices).toEqual([]);
        expect(after.replaceableFrom).not.toBeNull();
    });

    test("issuing a seed product to another account does not reveal it on your own products page", async () => {
        const page = member;
        const listed = accepted(
            z.object({ items: z.array(z.object({ accountId: z.string() })) }),
            await page.read(fn.fetchAccounts, {
                status: null,
                roleId: null,
                text: "bob",
                sort: "newest",
                cursor: null,
            }),
        );
        const bob = listed.items[0]?.accountId;
        invariant(bob !== undefined, "bob was added");
        accepted(
            z.object({ entitlementId: z.string() }),
            await page.call(fn.issueEntitlement, {
                operationId: newOperationId(createSeededRng(7005)),
                accountId: bob,
                validFrom: systemClock.now(),
                validUntil: null,
                productId: "cs2",
                features: "*",
                channels: ["alpha"],
            }),
        );
        const account = z
            .object({
                entitlements: z.array(
                    z.object({
                        status: z.string(),
                        products: z.array(
                            z.object({ productId: z.string(), channels: z.array(z.string()) }),
                        ),
                    }),
                ),
            })
            .parse(await page.read(fn.fetchAccount, { accountId: bob }));
        expect(account.entitlements).toEqual([
            { status: "active", products: [{ productId: "cs2", channels: ["alpha"] }] },
        ]);
        // Root holds no entitlement of its own.
        const visible = accepted(
            z.array(z.object({ productId: z.string(), state: z.string() })),
            await page.read(fn.fetchProducts),
        );
        expect(visible).toEqual([{ productId: "lucent-loader", state: "live" }]);
        expect((await page.get("/products")).status).toBe(200);
        expect((await page.get("/products/lucent-loader")).status).toBe(404);
        expect((await page.get("/download")).status).toBe(404);
        expect((await page.get("/products/cs2")).status).toBe(404);
    });

    test("staff promote a staged seal and then a fact set once a step-up proves them, and a seal below the current one is refused", async () => {
        const page = member;
        const releaseId = "5".repeat(32);
        const db = new SQL(platform.databaseUrl);
        // Staged as ops leaves them, on a channel no one here is entitled to: nothing below reads
        // the manifest or the bundle, so placeholder bytes stand in for them.
        await db`insert into release (id, product_id, channel, container, manifest)
                 values (decode(${releaseId}, 'hex'), 'cs2', 'debug', decode('01', 'hex'), decode('01', 'hex'))`;
        await db`insert into release_seal (product_id, channel, number, release_id, seal)
                 values ('cs2', 'debug', 1, decode(${releaseId}, 'hex'), decode('01', 'hex')),
                        ('cs2', 'debug', 2, decode(${releaseId}, 'hex'), decode('02', 'hex'))`;
        const [set] = await db`insert into fact_set (release_id, bundle, fact_keys)
                               values (decode(${releaseId}, 'hex'), decode('01', 'hex'), ''::bytea)
                               returning id::text as id`;
        await db`insert into fact_set_build
                     (set_id, release_id, name_hash, time_date_stamp, size_of_image, revision)
                 values (${set.id}::bigint, decode(${releaseId}, 'hex'), 4660, 1, 2, 1)`;
        await db`update browser_session set step_up_at = null`;

        const Lines = z.array(
            z.object({
                productId: z.string(),
                channel: z.string(),
                current: z.object({ number: z.string() }).nullable(),
                seals: z.array(z.object({ number: z.string() })),
            }),
        );
        const debugLine = async () =>
            accepted(Lines, await page.read(fn.listReleases)).find(
                (line) => line.productId === "cs2" && line.channel === "debug",
            );
        expect(await debugLine()).toEqual({
            productId: "cs2",
            channel: "debug",
            current: null,
            seals: [{ number: "2" }, { number: "1" }],
        });

        const promote = (number: string) =>
            page.call(fn.promoteRelease, { productId: "cs2", channel: "debug", number });
        expect(refusedCode(await promote("2"))).toBe("STEP_UP_REQUIRED");
        const proof = accepted(RequestOptions, await page.call(fn.beginStepUp));
        accepted(
            z.null(),
            await page.call(fn.finishStepUp, { response: await authenticator.assert(proof) }),
        );
        expect(accepted(z.boolean(), await promote("2"))).toBe(true);
        expect(refusedCode(await promote("1"))).toBe("SEAL_BELOW_CURRENT");
        expect((await debugLine())?.current).toEqual({ number: "2" });

        const listed = accepted(
            z.object({ sets: z.array(z.object({ setId: z.string(), revision: z.number() })) }),
            await page.read(fn.listFactSets, { releaseId }),
        );
        expect(listed.sets).toEqual([{ setId: set.id, revision: 1 }]);
        expect(
            accepted(z.boolean(), await page.call(fn.promoteFactSet, { releaseId, setId: set.id })),
        ).toBe(true);
        const [current] = await db`select revision::int as revision from current_fact_set
                                   where release_id = decode(${releaseId}, 'hex')`;
        expect(current.revision).toBe(1);
        const audited = await db`select operation from audit
                                 where operation in ('release.promote', 'fact_set.promote')
                                 order by id`;
        expect(audited.map((row: { operation: string }) => row.operation)).toEqual([
            "release.promote",
            "fact_set.promote",
        ]);
        await db.close();
    });

    test("the loader downloads as an attachment for a member with a product, and sends anyone else back to the download page", async () => {
        const page = member;
        const Offer = z.object({ state: z.string(), number: z.string().optional() });
        const file = "/download/lucent-loader.exe";
        expect(accepted(Offer, await page.read(fn.fetchLoaderOffer))).toEqual({
            state: "no_product",
        });
        const refused = await page.get(file);
        expect(refused.status).toBe(303);
        expect(refused.headers.get("location")).toEndWith("/products");

        // The golden loader seal (number 12) is current; its loader digest names the file.
        const seal = await readFile(join(WEB_DIR, "../contracts/release-seal/v1/loader.bin"));
        const loader = new TextEncoder().encode("MZ the loader under test");
        await Bun.write(join(artifactDir, "3d".repeat(32)), loader);
        const db = new SQL(platform.databaseUrl);
        const [root] = await db`select id from account where username = 'root'`;
        const entitlementId = `ent_${"e".repeat(22)}`;
        await db`insert into entitlement (id, account_id, status, valid_from, created_at)
                 values (${entitlementId}, ${root.id}, 'active', now(), now())`;
        await db`insert into entitlement_product (entitlement_id, product_id, features, channels)
                 values (${entitlementId}, 'cs2', '"*"'::jsonb, '{stable}')`;
        expect(accepted(Offer, await page.read(fn.fetchLoaderOffer))).toEqual({
            state: "no_release",
        });
        await db`insert into release (id, product_id, channel)
                 values (decode(${"4".repeat(32)}, 'hex'), 'lucent-loader', 'stable')`;
        await db`insert into release_seal (product_id, channel, number, release_id, seal)
                 values ('lucent-loader', 'stable', 12, decode(${"4".repeat(32)}, 'hex'), ${seal})`;
        await db`insert into current_release (product_id, channel, number)
                 values ('lucent-loader', 'stable', 12)`;
        await db.close();
        expect(accepted(Offer, await page.read(fn.fetchLoaderOffer))).toEqual({
            state: "ready",
            number: "12",
        });

        const served = await page.get(file);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-disposition")).toBe(
            'attachment; filename="lucent-loader.exe"',
        );
        expect(served.headers.get("cache-control")).toBe("no-store");
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(loader);

        const stranger = await browser().get(file);
        expect(stranger.status).toBe(303);
        expect(stranger.headers.get("location")).toEndWith("/products");
    });

    test("the member cloud page serves only metadata and issued links never enter HTML or request logs", async () => {
        const db = new SQL(platform.databaseUrl);
        const [root] = await db`select id from account where username='root'`;
        const grant = `ent_${"c".repeat(22)}`;
        await db`insert into entitlement (id,account_id,valid_from) values (${grant},${root.id},now())`;
        await db`insert into entitlement_product (entitlement_id,product_id,features,channels)
            values (${grant},'cs2','"*"'::jsonb,'{stable}')`;
        await db`insert into cloud_scope (account_id,product_id) values (${root.id},'cs2')`;
        const [item] = await db`insert into cloud_item (account_id,product_id,kind)
            values (${root.id},'cs2','script') returning item_id::text as id`;
        const body = "only-in-the-cloud-item-body";
        await db`insert into cloud_version (account_id,product_id,item_id,revision,name,bytes)
            values (${root.id},'cs2',${item.id},1,'test loadout',convert_to(${body},'UTF8'))`;
        await db.close();
        expect((await browser().get("/cloud")).status).toBe(303);
        expect(await (await member.get("/cloud")).text()).toContain("cs2");
        expect(await (await member.get("/cloud?product=cs2")).text()).toContain("test loadout");
        const key = { productId: "cs2", itemId: item.id };
        const newItem = {
            productId: "cs2",
            kind: "config",
            name: "empty profile",
            operationId: newOperationId(createSeededRng(7011)),
        };
        const created = z.object({ itemId: z.string() });
        const create = () => member.call("features.cloud.server--createEmptyItem", newItem);
        const empty = accepted(created, await create());
        expect(accepted(created, await create())).toEqual(empty);
        expect(
            refusedCode(
                await member.call("features.cloud.server--createEmptyItem", {
                    ...newItem,
                    name: "different",
                }),
            ),
        ).toBe("IDEMPOTENCY_CONFLICT");
        const createdPage = await member.get(`/cloud?product=cs2&item=${empty.itemId}`);
        expect(createdPage.status).toBe(200);
        expect(await createdPage.text()).toContain("empty profile");
        const link = accepted(
            z.object({ token: z.string(), shareId: z.string() }),
            await member.call("features.cloud.server--createShare", key),
        );
        const detail = await member.get(`/cloud?product=cs2&item=${item.id}`);
        expect(detail.status).toBe(200);
        const html = await detail.text();
        expect(html).toContain("test loadout");
        expect(html).toContain("revoke");
        expect(html).not.toContain(link.token);
        expect(html).not.toContain(body);
        const landing = await member.get(`/share#cs2/${link.token}`);
        expect(landing.status).toBe(200);
        expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await landing.text()).not.toContain(link.token);
        const guest = await browser().get(`/share#cs2/${link.token}`);
        expect(guest.status).toBe(200);
        expect(await guest.text()).toContain("open the link again");
        const importLink = () =>
            member.call("features.cloud.server--importShare", {
                productId: "cs2",
                token: link.token,
            });
        expect(accepted(created, await importLink()).itemId).not.toBe(item.id);
        accepted(
            z.null(),
            await member.call("features.cloud.server--revokeShare", {
                productId: "cs2",
                shareId: link.shareId,
            }),
        );
        expect(refusedCode(await importLink())).toBe("NOT_FOUND");
        expect(web.output()).not.toContain(link.token);
    });

    test("the changelog pages are for members: a signed-out visitor is sent to sign in, a member reads them unindexed", async () => {
        for (const path of ["/changes", "/changes/loader"]) {
            const stranger = await browser().get(path);
            expect(stranger.status).toBe(303);
            expect(stranger.headers.get("location")).toEndWith("/sign-in");
            const page = await member.get(path);
            expect(page.status).toBe(200);
            expect(await page.text()).toContain('<meta name="robots" content="noindex"');
        }
        expect((await (await member.get("/changes")).text()).toLowerCase()).toContain(
            "no changes yet",
        );
        // The pages they replace are gone.
        for (const path of ["/status", "/changelog", "/download"]) {
            expect((await member.get(path)).status).toBe(404);
        }
    });
});
