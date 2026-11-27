import { expect, test } from "bun:test";
import { systemClock } from "@lucent/core/clock";
import { invariant } from "@lucent/core/contain";
import { ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { AccountId } from "@lucent/core/scalars";
import { type Db, execute, sql } from "../src/base/db/pool.ts";
import { setBlock } from "../src/members/community/blocks.ts";
import {
    decideRoster,
    indexBlocks,
    ROSTER_CAP,
    type RosterRow,
} from "../src/members/community/events.rules.ts";
import { createEventHub, type EventHub } from "../src/members/community/events.ts";
import { createRosterProvider } from "../src/members/community/presence.ts";
import { setShows, setVisibility } from "../src/members/community/profiles.ts";
import { member } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const row = (username: string, over: Partial<RosterRow> = {}): RosterRow => ({
    accountId: AccountId.parse(`acc_${username.padEnd(22, "x").slice(0, 22)}`),
    username,
    avatar: null,
    inGame: false,
    shown: true,
    ...over,
});

test.each([
    ["empty stays empty", [], []],
    [
        "hidden rows are named never, however few",
        [row("a", { shown: false }), row("b")],
        [{ username: "b", avatar: null, inGame: false }],
    ],
    [
        "facts ride through in order",
        [row("a", { avatar: "ff".repeat(32), inGame: true }), row("b")],
        [
            { username: "a", avatar: "ff".repeat(32), inGame: true },
            { username: "b", avatar: null, inGame: false },
        ],
    ],
    [
        "the cap keeps the first, not the hidden",
        [
            ...Array.from({ length: ROSTER_CAP + 5 }, (_, n) =>
                row(`shown${String(n).padStart(2, "0")}`),
            ),
            row("hidden", { shown: false }),
        ],
        Array.from({ length: ROSTER_CAP }, (_, n) => ({
            username: `shown${String(n).padStart(2, "0")}`,
            avatar: null,
            inGame: false,
        })),
    ],
] as const)("decideRoster: %s", (_name, rows, expected) => {
    expect(decideRoster(rows)).toEqual(expected);
});

async function seedRuntimeSession(db: Db, accountId: AccountId, leaseMinutes: number) {
    const id = sql`decode(repeat('e4', 16), 'hex')`;
    const key = sql`decode(repeat('ab', 32), 'hex')`;
    const nonce = sql`decode(repeat('cd', 16), 'hex')`;
    expect(
        await execute(
            db,
            sql`insert into device (id, account_id, jkt, public_key, storage, enrolled_at)
                values (${id}, ${accountId}, ${`jkt-${accountId.slice(-8)}`}, '{}', 'software', now())`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into release (id, product_id, channel) values (${id}, 'cs2', 'stable')`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into release_seal (product_id, channel, number, release_id, seal)
                values ('cs2', 'stable', 1, ${id}, '\\x01')`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into session_start (id, account_id, device_id, product_id, channel, release_id,
                                           created_at, expires_at, consumed_at, release_number)
                values (${id}, ${accountId}, ${id}, 'cs2', 'stable', ${id},
                        now(), now() + interval '1 minute', now(), 1)`,
        ),
    ).toEqual(ok(1));
    expect(
        await execute(
            db,
            sql`insert into runtime_session (
                    id, start_id, account_id, device_id, product_id, channel, release_id,
                    slot_generation, module_key, server_key, boot_info_version, image_kind,
                    image_base, image_size, entitled_everything, entitled_features, created_at,
                    lease_sequence, lease_nonce, lease_challenge_nonce, lease_challenge_offset,
                    lease_challenge_size, loader_challenge_nonce, loader_challenge_offset,
                    loader_challenge_size, lease_issued_at, lease_expires_at, frame_in_sequence,
                    frame_out_sequence)
                values (${id}, ${id}, ${accountId}, ${id}, 'cs2', 'stable', ${id},
                        1, ${key}, ${key}, 1, 'mapped', 0, 4096, true, '{}', now(),
                        1, ${nonce}, ${nonce}, 0, 16, ${nonce}, 0, 16,
                        now(), now() + make_interval(mins => ${leaseMinutes}), 0, 1)`,
        ),
    ).toEqual(ok(1));
    return "e4".repeat(16);
}

test("the roster leaves out hidden and private accounts, caps at 50, and inGame answers a live runtime session", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18301);
        const open = await member(db, rng, "open@lucent.test", "open");
        const hidden = await member(db, rng, "hidden@lucent.test", "hidden");
        const priv = await member(db, rng, "priv@lucent.test", "priv");
        const gamer = await member(db, rng, "gamer@lucent.test", "gamer");
        expect(await setShows(db, hidden.token, { lastSeen: false })).toEqual(ok(undefined));
        expect(await setVisibility(db, priv.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );

        const provider = createRosterProvider(db, systemClock);
        const ids = [open.id, hidden.id, priv.id, gamer.id];
        const roster = decideRoster((await provider(ids)).rows);
        const names = roster.map((entry) => entry.username);
        expect(names).toContain("open");
        expect(names).toContain("gamer");
        expect(names).not.toContain("hidden");
        expect(names).not.toContain("priv");
        expect(roster.find((entry) => entry.username === "gamer")?.inGame).toBe(false);

        // A live runtime session flips inGame; the memo is younger than its TTL, so ask again
        // after it expires — or read with a fresh provider, which is what a restart answers.
        const leaseId = await seedRuntimeSession(db, gamer.id, 5);
        void leaseId;
        const live = decideRoster((await createRosterProvider(db, systemClock)(ids)).rows);
        expect(live.find((entry) => entry.username === "gamer")?.inGame).toBe(true);

        // An expired lease is not in game.
        await execute(
            db,
            sql`update runtime_session set lease_expires_at = now() - interval '1 minute'`,
        );
        const expired = decideRoster((await createRosterProvider(db, systemClock)(ids)).rows);
        expect(expired.find((entry) => entry.username === "gamer")?.inGame).toBe(false);

        // Cap: 60 visible accounts yield exactly 50 entries, all named.
        const crowd: AccountId[] = [];
        for (let n = 0; n < 60; n++) {
            crowd.push(
                (await member(db, rng, `roam${n}@lucent.test`, `roam${String(n).padStart(2, "0")}`))
                    .id,
            );
        }
        const big = decideRoster(
            (await createRosterProvider(db, systemClock)([...ids, ...crowd])).rows,
        );
        expect(big.length).toBe(ROSTER_CAP);
        expect(big.every((entry) => entry.username !== "hidden" && entry.username !== "priv")).toBe(
            true,
        );
    });
});

test("the hub's event carries the roster once the provider answers, and online counts everyone", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18302);
        const open = await member(db, rng, "open@lucent.test", "open2");
        const hidden = await member(db, rng, "hidden@lucent.test", "hidden2");
        expect(await setShows(db, hidden.token, { lastSeen: false })).toEqual(ok(undefined));

        const { createEventHub } = await import("../src/members/community/events.ts");
        const hub = createEventHub({ roster: createRosterProvider(db, systemClock) });
        const events: { online: number; roster: readonly string[] }[] = [];
        const joined = hub.connect(open.id, {
            send: (event) => {
                events.push({
                    online: event.online,
                    roster: event.roster.map((entry) => entry.username),
                });
                return true;
            },
            close: () => {},
        });
        invariant(joined.ok, "expected a stream");
        // Delivery is asynchronous once a roster provider reads.
        await Bun.sleep(50);
        expect(events.length).toBe(1);
        expect(events[0]?.roster).toEqual(["open2"]);

        const second = hub.connect(hidden.id, {
            send: () => true,
            close: () => {},
        });
        invariant(second.ok, "expected a stream");
        // Past the coalescing delay, the flush reaches the first stream: the hidden account is
        // counted in online, and still never named in the roster.
        await Bun.sleep(1_400);
        const last = events.at(-1);
        expect(last?.online).toBe(2);
        expect(hub.online()).toBe(2);
        expect(last?.roster).toEqual(["open2"]);
        hub.close();
    });
});

function watching(hub: EventHub, accountId: AccountId) {
    const rosters: (readonly string[])[] = [];
    const online: number[] = [];
    const joined = hub.connect(accountId, {
        send: (event) => {
            rosters.push(event.roster.map((entry) => entry.username));
            online.push(event.online);
            return true;
        },
        close: () => {},
    });
    invariant(joined.ok, "expected a stream");
    return { rosters, online };
}

// The hub answers once the roster is read, so a stream is given until its latest roster is the
// expected one rather than a fixed wait.
async function settled(
    stream: { readonly rosters: readonly (readonly string[])[] },
    expected: readonly string[],
) {
    for (let waited = 0; waited < 2_000; waited += 20) {
        if (JSON.stringify(stream.rosters.at(-1)) === JSON.stringify(expected)) break;
        await Bun.sleep(20);
    }
    return stream.rosters.at(-1);
}

test("each reader's roster leaves out accounts they share a block with, in either direction, and online stays the true count", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18303);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );

        const queued: (() => void)[] = [];
        const hub = createEventHub({
            roster: createRosterProvider(db, systemClock),
            schedule: (run) => queued.push(run),
        });
        const seen = [alice, bob, carol].map((who) => watching(hub, who.id));
        for (const run of queued.splice(0)) run();
        const [forAlice, forBob, forCarol] = seen;
        invariant(forAlice && forBob && forCarol, "expected three streams");
        expect(await settled(forAlice, ["alice", "carol"])).toEqual(["alice", "carol"]);
        expect(await settled(forBob, ["bob", "carol"])).toEqual(["bob", "carol"]);
        expect(await settled(forCarol, ["alice", "bob", "carol"])).toEqual([
            "alice",
            "bob",
            "carol",
        ]);
        expect([forAlice, forBob, forCarol].map((stream) => stream.online.at(-1))).toEqual([
            3, 3, 3,
        ]);
        hub.close();
    });
});

test("a change to a block, last seen or visibility rebuilds the roster for the streams on the next flush", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(18304);
        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const bob = await member(db, rng, "bob@lucent.test", "bob");
        const carol = await member(db, rng, "carol@lucent.test", "carol");

        const queued: (() => void)[] = [];
        const hub = createEventHub({
            roster: createRosterProvider(db, systemClock),
            schedule: (run) => queued.push(run),
        });
        const [forAlice, forBob] = [alice, bob, carol].map((who) => watching(hub, who.id));
        invariant(forAlice && forBob, "expected streams");
        for (const run of queued.splice(0)) run();
        expect(await settled(forAlice, ["alice", "bob", "carol"])).toEqual([
            "alice",
            "bob",
            "carol",
        ]);
        expect(await settled(forAlice, ["alice", "bob", "carol"])).toEqual([
            "alice",
            "bob",
            "carol",
        ]);

        const flush = async () => {
            for (const run of queued.splice(0)) run();
            await Bun.sleep(20);
        };
        // The connected set has not moved, so only the change's own notice makes a flush.
        expect(await setShows(db, carol.token, { lastSeen: false })).toEqual(ok(undefined));
        hub.rosterChanged();
        await flush();
        expect(await settled(forAlice, ["alice", "bob"])).toEqual(["alice", "bob"]);
        expect(await settled(forBob, ["alice", "bob"])).toEqual(["alice", "bob"]);

        expect(await setShows(db, carol.token, { lastSeen: true })).toEqual(ok(undefined));
        expect(await setVisibility(db, bob.token, { visibility: "private" })).toEqual(
            ok(undefined),
        );
        hub.rosterChanged();
        await flush();
        expect(await settled(forAlice, ["alice", "carol"])).toEqual(["alice", "carol"]);

        expect(await setVisibility(db, bob.token, { visibility: "members" })).toEqual(
            ok(undefined),
        );
        expect(await setBlock(db, alice.token, { username: "bob", blocked: true })).toEqual(
            ok(undefined),
        );
        hub.rosterChanged();
        await flush();
        expect(await settled(forAlice, ["alice", "carol"])).toEqual(["alice", "carol"]);
        expect(await settled(forBob, ["bob", "carol"])).toEqual(["bob", "carol"]);

        expect(await setBlock(db, alice.token, { username: "bob", blocked: false })).toEqual(
            ok(undefined),
        );
        hub.rosterChanged();
        await flush();
        expect(await settled(forAlice, ["alice", "bob", "carol"])).toEqual([
            "alice",
            "bob",
            "carol",
        ]);
        expect(await settled(forBob, ["alice", "bob", "carol"])).toEqual(["alice", "bob", "carol"]);
        hub.close();
    });
});

test("decideRoster leaves out the accounts hidden from the reader and fills the cap with the rest", () => {
    const rows = Array.from({ length: ROSTER_CAP + 2 }, (_, n) =>
        row(`n${String(n).padStart(2, "0")}`),
    );
    const first = rows[0];
    invariant(first !== undefined, "expected a row");
    const named = decideRoster(rows, new Set([first.accountId]));
    expect(named.length).toBe(ROSTER_CAP);
    expect(named[0]?.username).toBe("n01");
    expect(
        indexBlocks([
            {
                blocker: rows[0]?.accountId ?? first.accountId,
                blocked: rows[1]?.accountId ?? first.accountId,
            },
        ])
            .get(rows[1]?.accountId ?? first.accountId)
            ?.has(first.accountId),
    ).toBe(true);
});
