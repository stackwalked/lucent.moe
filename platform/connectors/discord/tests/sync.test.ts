import { afterAll, beforeAll, expect, test } from "bun:test";
import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import {
    type AccountId,
    BearerToken,
    newAccountId,
    newOperationId,
    newSessionId,
    toBase64Url,
} from "@lucent/core/scalars";
import { createRpcClient } from "@lucent/rpc/client";
import { DISCORD_RPC_PATH, discordContract } from "@lucent/rpc/discord/contract";
import { webContract } from "@lucent/rpc/web";
import { type RunningPlatform, startPlatform } from "@lucent/testing/platform";
import {
    allocateEphemeralPort,
    sharedEphemeralCluster,
    shutdownSharedEphemeralCluster,
} from "@lucent/testing/postgres";
import { SQL } from "bun";
import { z } from "zod";
import { createConnector } from "../src/connector.ts";
import {
    DM_COPY,
    FEEDS_COPY,
    ME_COPY,
    QUEUE_COPY,
    REPLIES,
    STAFF_COPY,
    TICKET_COPY,
} from "../src/copy.ts";
import type { LogFields, Logger } from "../src/log.ts";
import { type FakeDiscord, startFakeDiscord } from "../testing/fake-discord.ts";

// The connector against platform as an operator starts it, in its own process, and a stand-in
// Discord in this one. Staff act through web's own admin procedures; their sessions are rows
// written here, as a sign-in would have left them.

const KEY = "integration-discord-peer-key-not-a-secret-0123456789";
const GUILD = "500000000000000001";
const ALICE = "500000000000000010";
const BOB = "500000000000000011";
const CAROL = "500000000000000012";
const DAVE = "500000000000000013";
const LINKED = "500000000000000100";
const CS2_ROLE = "500000000000000101";
const HAND_GIVEN = "500000000000000199";
const STATUS_CHANNEL = "500000000000000200";
const RESOURCES_CHANNEL = "500000000000000201";

let platform: RunningPlatform;
let db: SQL;
// The Discord the platform joins and identifies applicants against; started first, for its URL.
let oauthFake: FakeDiscord;
let site: string;

beforeAll(async () => {
    site = `http://localhost:${allocateEphemeralPort()}`;
    oauthFake = startFakeDiscord({ guildId: GUILD, clock: systemClock });
    platform = await startPlatform({
        cluster: await sharedEphemeralCluster(),
        database: "discord_sync",
        webOrigin: site,
        discordInternalKey: KEY,
        discordOauth: { apiUrl: `${oauthFake.api}/v10`, guildId: GUILD },
    });
    db = new SQL(platform.databaseUrl);
}, 60_000);

afterAll(async () => {
    await db.close();
    await platform.stop();
    await oauthFake.stop();
    await shutdownSharedEphemeralCluster();
});

const rng = createSeededRng(3001);

// A member session, stepped up just now, as sign-in and a passkey step-up leave one.
async function sessionFor(accountId: string): Promise<BearerToken> {
    const token = BearerToken.parse(toBase64Url(rng.fillBytes(new Uint8Array(32))));
    const hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    );
    await db`insert into browser_session (token_hash, public_id, account_id, purpose, created_at,
                                          expires_at, authenticated_at, step_up_at, last_seen_at)
             values (${hash}, ${newSessionId(rng)}, ${accountId}, 'member', now(),
                     now() + interval '1 hour', now(), now(), now())`;
    return token;
}

async function until(what: string, done: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        if (done()) return;
        await Bun.sleep(10);
    }
    invariant(false, `${what} did not happen`);
}

const sorted = (...roles: readonly string[]) => [...roles].sort();

test("the connector mirrors standing into the guild within a tick, and a reconcile repairs it", async () => {
    const web = createRpcClient(webContract, {
        endpointUrl: `${platform.internalUrl}/internal/web/rpc`,
        peerKey: platform.peerKey,
    });
    const discord = createRpcClient(discordContract, {
        endpointUrl: `${platform.internalUrl}${DISCORD_RPC_PATH}`,
        peerKey: KEY,
    });
    const [root] = await db`select id from account where is_root`;
    invariant(typeof root?.id === "string", "root was bootstrapped");
    const staff = await sessionFor(root.id);
    const member: AccountId = newAccountId(rng);
    const other: AccountId = newAccountId(rng);
    await db`insert into account (id, email) values (${member}, 'member@lucent.test'),
                                                    (${other}, 'other@lucent.test')`;

    // The connector's key opens nothing on web's path.
    expect(
        await createRpcClient(webContract, {
            endpointUrl: `${platform.internalUrl}/internal/web/rpc`,
            peerKey: KEY,
        }).call("health.check", {}),
    ).toEqual({ ok: false, error: { code: "AUTH_REQUIRED" } });

    const ruleIds: string[] = [];
    for (const fields of [
        { kind: "role", roleId: LINKED, condition: { kind: "linked" } },
        { kind: "role", roleId: CS2_ROLE, condition: { kind: "entitled", productId: "cs2" } },
        { kind: "feed", channelId: STATUS_CHANNEL, feed: "status" },
        { kind: "feed", channelId: RESOURCES_CHANNEL, feed: "resources" },
    ] as const) {
        const added = await web.call("admin.discord.rules.add", { fields }, { session: staff });
        invariant(added.ok, "the rule was added");
        ruleIds.push(added.value.ruleId);
    }
    expect(
        await web.call(
            "admin.discord.rules.add",
            {
                fields: {
                    kind: "role",
                    roleId: CS2_ROLE,
                    condition: { kind: "holds_role", roleId: "role_nobody" },
                },
            },
            { session: staff },
        ),
    ).toEqual({ ok: false, error: { code: "NOT_FOUND" } });

    const lines: { readonly msg: string; readonly fields?: LogFields }[] = [];
    const logger: Logger = {
        write: (_level, msg, fields) => {
            lines.push(fields === undefined ? { msg } : { msg, fields });
        },
    };
    const fake = oauthFake;
    fake.addMember(ALICE, [HAND_GIVEN]);
    // Given a synced role by hand without a link: the first reconcile takes it back.
    fake.addMember(BOB, [LINKED]);
    const connector = createConnector({
        platform: discord,
        botToken: `bot.${"t".repeat(66)}`,
        guildId: GUILD,
        logger,
        discordApi: fake.api,
        schedule: "manual",
    });
    expect((await connector.start()).ok).toBe(true);
    await fake.ready();
    await until("ready", () => lines.some((line) => line.msg === "ready"));
    await connector.idle();
    expect(fake.commands()).toEqual([
        "unlink",
        "me",
        "status",
        "ticket",
        "who",
        "brief",
        "releases",
        "who is this",
    ]);
    expect(fake.roles(BOB)).toEqual([]);

    // Linking through Discord's OAuth: a code works once, and the link reaches roles at the next
    // tick.
    const memberSession = await sessionFor(member);
    const aliceCode = fake.authorize(ALICE, "alice");
    expect(
        await web.call("discord.link.finish", { code: aliceCode }, { session: memberSession }),
    ).toEqual({ ok: true, value: {} });
    expect(
        await web.call(
            "discord.link.finish",
            { code: aliceCode },
            { session: await sessionFor(other) },
        ),
    ).toEqual({ ok: false, error: { code: "DISCORD_LINK_FAILED" } });
    // A linked account is refused before the code is exchanged, so nobody is joined for it.
    expect(
        await web.call(
            "discord.link.finish",
            { code: fake.authorize(DAVE, "dave") },
            { session: memberSession },
        ),
    ).toEqual({ ok: false, error: { code: "ALREADY_LINKED" } });
    expect(fake.isMember(DAVE)).toBe(false);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual(sorted(LINKED, HAND_GIVEN));

    // An entitlement granted in admin reaches Discord at the next tick.
    const [now] = await db`select (extract(epoch from now()) * 1000)::bigint as ms`;
    const issued = await web.call(
        "admin.entitlements.issue",
        {
            operationId: newOperationId(rng),
            accountId: member,
            validFrom: Number(now?.ms),
            validUntil: null,
            products: [{ productId: "cs2", features: "*", channels: ["stable"] }],
        },
        { session: staff },
    );
    expect(issued.ok).toBe(true);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual(sorted(LINKED, CS2_ROLE, HAND_GIVEN));

    // Removed by hand, once the audit rows are older than the window a tick reads again: no
    // tick sees it, and the reconcile repairs it.
    await db`update audit set at = at - interval '1 minute'`;
    fake.setRoles(ALICE, [HAND_GIVEN]);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual([HAND_GIVEN]);
    await connector.reconcile();
    expect(fake.roles(ALICE)).toEqual(sorted(LINKED, CS2_ROLE, HAND_GIVEN));

    // A suspension removes every synced role and nothing else; reinstating gives them back.
    const suspended = await web.call(
        "admin.accounts.suspend",
        { operationId: newOperationId(rng), accountId: member, reason: "test" },
        { session: staff },
    );
    expect(suspended.ok).toBe(true);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual([HAND_GIVEN]);
    const reinstated = await web.call(
        "admin.accounts.reinstate",
        { operationId: newOperationId(rng), accountId: member },
        { session: staff },
    );
    expect(reinstated.ok).toBe(true);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual(sorted(LINKED, CS2_ROLE, HAND_GIVEN));

    // Unlinked on the site: the next tick removes them all.
    const unlinked = await web.call(
        "discord.link.remove",
        {},
        { session: await sessionFor(member) },
    );
    expect(unlinked.ok).toBe(true);
    await connector.tick();
    expect(fake.roles(ALICE)).toEqual([HAND_GIVEN]);
    expect(await fake.command("unlink", ALICE)).toEqual({
        kind: "message",
        content: REPLIES.notLinked,
        ephemeral: true,
        buttonUrl: null,
    });

    // A Discord user who was not in the guild is joined by linking, and has the roles at the
    // next tick.
    expect(
        await web.call(
            "discord.link.finish",
            { code: fake.authorize(CAROL, "carol") },
            { session: await sessionFor(other) },
        ),
    ).toEqual({ ok: true, value: {} });
    await connector.tick();
    expect(fake.roles(CAROL)).toEqual([LINKED]);

    // A removed rule takes its role off whoever it had given it to; a role in no rule would
    // otherwise never be touched again, through suspension and unlinking alike.
    const [linkedRule] = ruleIds;
    invariant(linkedRule !== undefined, "the linked rule exists");
    const removed = await web.call(
        "admin.discord.rules.remove",
        { ruleId: linkedRule },
        { session: staff },
    );
    expect(removed.ok).toBe(true);
    await connector.tick();
    expect(fake.roles(CAROL)).toEqual([]);
    expect(fake.roles(ALICE)).toEqual([HAND_GIVEN]);

    // A resource for everyone goes out; ones for a product the public home doesn't list stay,
    // and however many of those are waiting they never hold the others back.
    for (const [title, productId, age] of [
        ...Array.from({ length: 25 }, (_, i) => [`seed notes ${i}`, "cs2", 60 - i] as const),
        ["*setup* guide", null, 0],
    ] as const) {
        await db`insert into resource (product_id, title, description, file_name, digest, size,
                                       published_by, published_at, updated_at)
                 values (${productId}, ${title}, '', 'file.txt', ${"0".repeat(64)}, 1, ${root.id},
                         now() - ${age} * interval '1 second', now())`;
    }
    await connector.tick();
    await connector.tick();

    // Each feed said its piece once, however many ticks ran.
    expect(fake.messages()).toEqual([
        {
            channelId: STATUS_CHANNEL,
            content: FEEDS_COPY.status("Lucent Loader", "live", null),
            buttonUrl: `${site}/`,
        },
        {
            channelId: RESOURCES_CHANNEL,
            content: FEEDS_COPY.resource("*setup* guide", null),
            buttonUrl: `${site}/resources`,
        },
    ]);
    expect(fake.messages()[1]?.content).toBe("new resource: **\\*setup\\* guide**");

    // A dropped connection resumes its session rather than starting a new one.
    fake.dropGateway();
    await until("resumed", () => fake.resumes() === 1);
    expect(fake.identifies()).toBe(1);

    expect(lines.filter((line) => line.msg.endsWith("failed"))).toEqual([]);
    await connector.stop();
}, 30_000);

const webClient = () =>
    createRpcClient(webContract, {
        endpointUrl: `${platform.internalUrl}/internal/web/rpc`,
        peerKey: platform.peerKey,
    });
const discordClient = (fetcher?: (req: Request) => Promise<Response>) =>
    createRpcClient(discordContract, {
        endpointUrl: `${platform.internalUrl}${DISCORD_RPC_PATH}`,
        peerKey: KEY,
        ...(fetcher === undefined ? {} : { fetcher }),
    });

const Called = z.object({ procedure: z.string() });

// Platform as the connector reaches it, except that `procedure` takes `slow` (or until the call
// gives up) or is never answered at all.
function degraded(procedure: string, how: { readonly slowMs: number } | "down") {
    return discordClient(async (req) => {
        const { procedure: called } = Called.parse(await req.clone().json());
        if (called !== procedure) return await fetch(req);
        if (how === "down") return new Response(null, { status: 503 });
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, how.slowMs);
            req.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        return await fetch(req);
    });
}

async function rootSession(): Promise<BearerToken> {
    const [root] = await db`select id from account where is_root`;
    invariant(typeof root?.id === "string", "root was bootstrapped");
    return await sessionFor(root.id);
}

// An account with a member session, linked to `userId` through the OAuth flow.
async function linkedMember(email: string, userId: string) {
    const accountId: AccountId = newAccountId(rng);
    await db`insert into account (id, email) values (${accountId}, ${email})`;
    const session = await sessionFor(accountId);
    const linked = await webClient().call(
        "discord.link.finish",
        { code: oauthFake.authorize(userId, `user${userId.slice(-3)}`) },
        { session },
    );
    invariant(linked.ok, "the code linked");
    return { accountId, session };
}

async function connected(
    guildId: string,
    members: readonly string[],
    reach: ReturnType<typeof discordClient> = discordClient(),
) {
    const lines: { readonly msg: string; readonly fields?: LogFields }[] = [];
    const logger: Logger = {
        write: (_level, msg, fields) => {
            lines.push(fields === undefined ? { msg } : { msg, fields });
        },
    };
    const fake = startFakeDiscord({ guildId, clock: systemClock });
    for (const member of members) fake.addMember(member);
    const connector = createConnector({
        platform: reach,
        botToken: `bot.${"t".repeat(66)}`,
        guildId,
        logger,
        discordApi: fake.api,
        schedule: "manual",
    });
    expect((await connector.start()).ok).toBe(true);
    await fake.ready();
    await until("ready", () => lines.some((line) => line.msg === "ready"));
    await connector.idle();
    return {
        fake,
        connector,
        lines,
        stop: async () => {
            await connector.stop();
            await fake.stop();
        },
    };
}

test("/me says what the site shows the linked account, and an unlinked user learns nothing", async () => {
    const DANA = "510000000000000001";
    const EVE = "510000000000000002";
    const FRANK = "510000000000000003";
    const web = webClient();
    const staff = await rootSession();
    const dana = await linkedMember("dana@lucent.test", DANA);
    const frank = await linkedMember("frank@lucent.test", FRANK);
    const [now] = await db`select (extract(epoch from now()) * 1000)::bigint as ms`;
    const until30 = Number(now?.ms) + 30 * 24 * 60 * 60_000;
    const issued = await web.call(
        "admin.entitlements.issue",
        {
            operationId: newOperationId(rng),
            accountId: dana.accountId,
            validFrom: Number(now?.ms),
            validUntil: until30,
            products: [{ productId: "cs2", features: "*", channels: ["stable"] }],
        },
        { session: staff },
    );
    expect(issued.ok).toBe(true);
    expect((await web.call("discord.link.remove", {}, { session: frank.session })).ok).toBe(true);
    const { fake, stop } = await connected("510000000000000100", [DANA, EVE, FRANK]);

    const me = await discordClient().call("me.read", { userId: DANA });
    const products = await web.call("products.list", {}, { session: dana.session });
    const devices = await web.call("devices.list", {}, { session: dana.session });
    invariant(me.ok && products.ok && devices.ok, "both sides answered");
    invariant(me.value.standing === "active", "dana is in good standing");
    expect(me.value.products).toEqual(
        products.value.products.map(({ productId, name, state, features, channels }) => ({
            productId,
            name,
            state,
            features,
            channels,
        })),
    );
    expect(me.value.devices).toEqual({
        count: devices.value.devices.length,
        limit: devices.value.limit,
    });
    expect(Number(me.value.nextExpiry)).toBe(until30);
    const reply = await fake.command("me", DANA);
    invariant(reply.kind === "message", "a message");
    expect(reply.ephemeral).toBe(true);
    for (const product of me.value.products)
        expect(reply.content).toContain(ME_COPY.product(product));
    expect(reply.content).toContain(ME_COPY.devices(0, devices.value.limit));
    expect(reply.content).toContain(ME_COPY.nextExpiry(me.value.nextExpiry));

    // Never linked, and linked to an account since unlinked: the same words, about nobody.
    const nobody = await fake.command("me", EVE);
    expect(nobody).toEqual({
        kind: "message",
        content: REPLIES.linkFirst(`${site}/account`),
        ephemeral: true,
        buttonUrl: null,
    });
    expect(await fake.command("me", FRANK)).toEqual(nobody);
    expect(await discordClient().call("me.read", { userId: FRANK })).toEqual({
        ok: true,
        value: { standing: "unlinked" },
    });

    expect(await fake.command("status", EVE)).toEqual({
        kind: "message",
        content: FEEDS_COPY.status("Lucent Loader", "live", null),
        ephemeral: false,
        buttonUrl: null,
    });
    await stop();
}, 30_000);

test("/ticket opens a ticket the site shows under the linked account", async () => {
    const GRACE = "520000000000000001";
    const HEIDI = "520000000000000002";
    const web = webClient();
    const grace = await linkedMember("grace@lucent.test", GRACE);
    const { fake, stop } = await connected("520000000000000100", [GRACE, HEIDI]);

    const listed = await web.call("products.list", {}, { session: grace.session });
    invariant(listed.ok, "products listed");
    const form = await fake.command("ticket", GRACE);
    expect(form).toEqual({
        kind: "modal",
        customId: "ticket",
        options: ["none", ...listed.value.products.map((p) => p.productId)],
    });
    const answer = await fake.submit(
        "ticket",
        GRACE,
        { subject: "it won't start", body: "the loader closes at once" },
        ["none"],
    );
    invariant(answer.kind === "message", "a message");
    expect(answer.ephemeral).toBe(true);
    expect(answer.content).toBe(TICKET_COPY.opened);
    const tickets = await web.call("tickets.list", { cursor: null }, { session: grace.session });
    invariant(tickets.ok, "tickets listed");
    const [ticket] = tickets.value.items;
    expect(ticket?.subject).toBe("it won't start");
    expect(answer.buttonUrl).toBe(`${site}/support/${ticket?.id}`);

    expect(await fake.command("ticket", HEIDI)).toEqual({
        kind: "message",
        content: REPLIES.linkFirst(`${site}/account`),
        ephemeral: true,
        buttonUrl: null,
    });

    // Text that is only blank is said to be blank, not taken for platform being away.
    expect(
        await fake.submit("ticket", GRACE, { subject: "   ", body: "the loader closes" }, ["none"]),
    ).toEqual({ kind: "message", content: TICKET_COPY.empty, ephemeral: true, buttonUrl: null });
    await stop();
}, 30_000);

test("/ticket answers within Discord's three seconds when platform is slow to list products", async () => {
    const LEO = "540000000000000001";
    await linkedMember("leo@lucent.test", LEO);
    const { fake, stop } = await connected(
        "540000000000000100",
        [LEO],
        degraded("tickets.products", { slowMs: 3_500 }),
    );
    expect(await fake.command("ticket", LEO)).toEqual({
        kind: "message",
        content: REPLIES.unavailable,
        ephemeral: true,
        buttonUrl: null,
    });
    await stop();
}, 30_000);

test("/me still answers when the connector hasn't learnt the site's origin yet", async () => {
    const MIA = "550000000000000001";
    await linkedMember("mia@lucent.test", MIA);
    const { fake, stop } = await connected(
        "550000000000000100",
        [MIA],
        degraded("rules.read", "down"),
    );
    const reply = await fake.command("me", MIA);
    invariant(reply.kind === "message", `a message, not ${reply.kind}`);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain(ME_COPY.heading);
    expect(reply.buttonUrl).toBeNull();
    await stop();
}, 30_000);

test("a notice goes out as a DM; closed DMs and failures lose nothing and are not retried forever", async () => {
    const IVAN = "530000000000000001";
    const JUDY = "530000000000000002";
    const KARL = "530000000000000003";
    const members = await Promise.all(
        [
            ["ivan@lucent.test", IVAN],
            ["judy@lucent.test", JUDY],
            ["karl@lucent.test", KARL],
        ].map(([email = "", userId = ""]) => linkedMember(email, userId)),
    );
    const { fake, connector, stop } = await connected("530000000000000100", [IVAN, JUDY, KARL]);
    fake.setDms(JUDY, "closed");
    fake.setDms(KARL, "failing");
    // As a security notice's transaction leaves them for members who chose Discord.
    for (const { accountId } of members) {
        await db`insert into inbox_entry (account_id, kind) values (${accountId}, 'security')`;
        await db`insert into connector_discord_dm (account_id, kind, next_attempt_at, created_at)
                 values (${accountId}, 'security', now(), now())`;
    }
    // An ending subscription, as a notice names no product the member may not see.
    const endsAt = 1_800_000_000_000;
    await db`insert into connector_discord_dm (account_id, kind, ends_at, next_attempt_at, created_at)
             values (${members[0]?.accountId ?? ""}, 'subscription_ending', to_timestamp(${endsAt / 1000}), now(), now())`;
    await connector.tick();

    expect(fake.dms(IVAN)).toEqual([
        {
            channelId: expect.any(String),
            content: DM_COPY.security,
            buttonUrl: `${site}/account/inbox`,
        },
        {
            channelId: expect.any(String),
            content: DM_COPY.subscriptionEnding(null, endsAt),
            buttonUrl: `${site}/account/inbox`,
        },
    ]);
    expect(fake.dmAttempts(JUDY)).toBe(1);
    for (let round = 0; round < 6; round += 1) {
        await db`update connector_discord_dm set next_attempt_at = now()`;
        await connector.tick();
    }
    expect(fake.dmAttempts(JUDY)).toBe(1);
    expect(fake.dmAttempts(KARL)).toBe(4);
    expect(fake.dms(JUDY)).toEqual([]);
    expect(fake.dms(KARL)).toEqual([]);
    const [left] = await db`select count(*)::int as count from connector_discord_dm`;
    expect(left?.count).toBe(0);
    const ids = members.map((m) => m.accountId);
    const [inbox] = await db`select count(*)::int as count from inbox_entry
                             where account_id in ${db(ids)}`;
    expect(inbox?.count).toBe(3);
    await stop();
}, 30_000);

test("staff reads answer in a staff channel only, and a ticket's queue post follows the site within a tick", async () => {
    const GUILD = "560000000000000100";
    const STAFF_ROOM = "560000000000000200";
    const LOBBY = "560000000000000201";
    const ROOT_USER = "560000000000000001";
    const NINA = "560000000000000002";
    const web = webClient();
    const staff = await rootSession();
    const [root] = await db`select id from account where is_root`;
    invariant(typeof root?.id === "string", "root was bootstrapped");
    expect(
        (
            await web.call(
                "discord.link.finish",
                { code: oauthFake.authorize(ROOT_USER, "root") },
                { session: staff },
            )
        ).ok,
    ).toBe(true);
    for (const fields of [
        { kind: "staff_channel", channelId: STAFF_ROOM },
        { kind: "feed", channelId: STAFF_ROOM, feed: "tickets" },
    ] as const) {
        expect((await web.call("admin.discord.rules.add", { fields }, { session: staff })).ok).toBe(
            true,
        );
    }
    const nina = await linkedMember("nina@lucent.test", NINA);
    await db`update account set username = 'nina' where id = ${nina.accountId}`;
    const { fake, connector, stop } = await connected(GUILD, [ROOT_USER, NINA]);

    // In the staff channel the answer is for the channel; anywhere else, or for a member, it is
    // the one refusal, said only to the asker.
    const who = await fake.command(
        "who",
        ROOT_USER,
        { account: "nina" },
        { channelId: STAFF_ROOM },
    );
    invariant(who.kind === "message", "a message");
    expect(who.ephemeral).toBe(false);
    // nina has no credentials yet: the admin page says the same.
    expect(who.content).toContain(STAFF_COPY.whoHeading("nina", "setup_pending"));
    expect(who.content).toContain(STAFF_COPY.discord(NINA));
    expect(who.content).not.toContain("nina@lucent.test");
    expect(who.buttonUrl).toBe(`${site}/admin/accounts/${nina.accountId}`);
    const refused = {
        kind: "message",
        content: STAFF_COPY.refused,
        ephemeral: true,
        buttonUrl: null,
    } as const;
    expect(await fake.command("who", ROOT_USER, { account: "nina" }, { channelId: LOBBY })).toEqual(
        refused,
    );
    expect(await fake.command("who", NINA, { account: "nina" }, { channelId: LOBBY })).toEqual(
        refused,
    );
    const byMenu = await fake.userCommand("who is this", ROOT_USER, NINA, STAFF_ROOM);
    invariant(byMenu.kind === "message", "a message");
    expect(byMenu.buttonUrl).toBe(`${site}/admin/accounts/${nina.accountId}`);
    const byMember = await fake.command(
        "who",
        ROOT_USER,
        {},
        {
            channelId: STAFF_ROOM,
            users: { member: NINA },
        },
    );
    invariant(byMember.kind === "message", "a message");
    expect(byMember.content).toBe(byMenu.content);
    for (const name of ["brief", "releases"]) {
        const read = await fake.command(name, ROOT_USER, {}, { channelId: STAFF_ROOM });
        invariant(read.kind === "message", "a message");
        expect(read.ephemeral).toBe(false);
        expect(read.content).not.toBe(STAFF_COPY.refused);
    }

    // A ticket opened on the site is posted to the queue; answered there, the post is edited.
    const opened = await web.call(
        "tickets.open",
        { productId: null, subject: "help please", body: "it closes" },
        { session: nina.session },
    );
    invariant(opened.ok, "the ticket opened");
    await connector.tick();
    const queued = {
        ticketKind: "help",
        subject: "help please",
        product: null,
        username: "nina",
    } as const;
    expect(fake.messages().filter((m) => m.channelId === STAFF_ROOM)).toEqual([
        {
            channelId: STAFF_ROOM,
            content: QUEUE_COPY.ticket({ ...queued, state: "open" }),
            buttonUrl: `${site}/admin/tickets/${opened.value.ticketId}`,
        },
    ]);
    const replied = await web.call(
        "admin.tickets.reply",
        { ticketId: opened.value.ticketId, body: "try again" },
        { session: staff },
    );
    expect(replied.ok).toBe(true);
    await connector.tick();
    expect(fake.edits()).toEqual([
        {
            channelId: STAFF_ROOM,
            messageId: expect.any(String),
            content: QUEUE_COPY.ticket({ ...queued, state: "answered" }),
            buttonUrl: `${site}/admin/tickets/${opened.value.ticketId}`,
        },
    ]);
    expect(fake.messages().filter((m) => m.channelId === STAFF_ROOM)).toHaveLength(1);
    await connector.tick();
    expect(fake.edits()).toHaveLength(1);

    // Its post deleted by hand, the ticket's next state is posted afresh, not lost.
    fake.clearByHand(STAFF_ROOM);
    const closed = await web.call(
        "tickets.close",
        { ticketId: opened.value.ticketId },
        { session: nina.session },
    );
    expect(closed.ok).toBe(true);
    await connector.tick();
    expect(fake.messages().filter((m) => m.channelId === STAFF_ROOM)).toEqual([
        expect.objectContaining({ content: QUEUE_COPY.ticket({ ...queued, state: "open" }) }),
        expect.objectContaining({ content: QUEUE_COPY.ticket({ ...queued, state: "closed" }) }),
    ]);

    // A Discord invite is taken down where members talk, and left alone in a staff channel.
    const leaked = fake.say(LOBBY, NINA, "join us at discord.gg/abcdef");
    fake.say(STAFF_ROOM, ROOT_USER, "the partner server: discord.gg/abcdef");
    fake.say(LOBBY, NINA, "no links here");
    await until("the invite is removed", () => fake.deleted().length > 0);
    await Bun.sleep(50);
    expect(fake.deleted()).toEqual([{ channelId: LOBBY, messageId: leaked }]);

    // An invite to this guild stays; one added by an edit, or forwarded in, goes.
    fake.ownInvite("lucent");
    fake.say(LOBBY, NINA, "bring a friend: https://discord.gg/lucent");
    const amended = fake.say(LOBBY, NINA, "see you there");
    fake.amend(LOBBY, amended, NINA, "see you there: discord.com/invite/elsewhere");
    const forwarded = fake.forward(LOBBY, NINA, "discord.gg/elsewhere");
    await until("the edit and the forward are removed", () => fake.deleted().length >= 3);
    await Bun.sleep(50);
    expect(
        fake
            .deleted()
            .map((d) => d.messageId)
            .sort(),
    ).toEqual([leaked, amended, forwarded].sort());
    await stop();
}, 30_000);
