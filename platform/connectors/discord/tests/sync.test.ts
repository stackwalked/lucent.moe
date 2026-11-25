import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { createConnector } from "../src/connector.ts";
import { FEEDS_COPY, REPLIES } from "../src/copy.ts";
import type { LogFields, Logger } from "../src/log.ts";
import { startFakeDiscord } from "../testing/fake-discord.ts";

// The connector against platform as an operator starts it, in its own process, and a stand-in
// Discord in this one. Staff act through web's own admin procedures; their sessions are rows
// written here, as a sign-in would have left them.

const KEY = "integration-discord-peer-key-not-a-secret-0123456789";
const GUILD = "500000000000000001";
const ALICE = "500000000000000010";
const BOB = "500000000000000011";
const CAROL = "500000000000000012";
const LINKED = "500000000000000100";
const CS2_ROLE = "500000000000000101";
const HAND_GIVEN = "500000000000000199";
const STATUS_CHANNEL = "500000000000000200";
const RESOURCES_CHANNEL = "500000000000000201";

let platform: RunningPlatform;
let db: SQL;
let site: string;

beforeAll(async () => {
    site = `http://localhost:${allocateEphemeralPort()}`;
    platform = await startPlatform({
        cluster: await sharedEphemeralCluster(),
        database: "discord_sync",
        webOrigin: site,
        discordInternalKey: KEY,
    });
    db = new SQL(platform.databaseUrl);
}, 60_000);

afterAll(async () => {
    await db.close();
    await platform.stop();
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
    const fake = startFakeDiscord({ guildId: GUILD });
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
    expect(fake.commands()).toEqual(["link", "unlink"]);
    expect(fake.roles(BOB)).toEqual([]);

    // Linking: a wrong code is refused; the member's own links and syncs at once.
    expect(await fake.command("link", ALICE, { code: "AAAAA-AAAAA" })).toEqual({
        content: REPLIES.codeInvalid(`${site}/account/discord`),
        ephemeral: true,
    });
    const memberSession = await sessionFor(member);
    const started = await web.call("discord.link.start", {}, { session: memberSession });
    invariant(started.ok, "a code was issued");
    expect(await fake.command("link", ALICE, { code: started.value.code })).toEqual({
        content: REPLIES.linked,
        ephemeral: true,
    });
    await connector.idle();
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
        content: REPLIES.notLinked,
        ephemeral: true,
    });

    // Linked before joining: the join syncs them.
    const otherCode = await web.call(
        "discord.link.start",
        {},
        { session: await sessionFor(other) },
    );
    invariant(otherCode.ok, "a second code was issued");
    expect(
        await discord.call("links.redeem", { userId: CAROL, code: otherCode.value.code }),
    ).toEqual({ ok: true, value: {} });
    fake.join(CAROL);
    await until("join synced", () => fake.roles(CAROL).length > 0);
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
    await fake.stop();
}, 30_000);
