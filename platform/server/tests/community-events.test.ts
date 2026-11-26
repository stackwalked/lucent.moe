import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { AccountId } from "@lucent/core/scalars";
import { Hono } from "hono";
import { execute, sql } from "../src/base/db/pool.ts";
import { mountCommunityEvents } from "../src/edge/listeners/internal/events.ts";
import {
    decideStreamAdmission,
    MAX_STREAMS,
    MAX_STREAMS_PER_ACCOUNT,
} from "../src/members/community/events.rules.ts";
import { createEventHub, type PresenceEvent } from "../src/members/community/events.ts";
import { member } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const alice = AccountId.parse(`acc_${"a".repeat(22)}`);
const bob = AccountId.parse(`acc_${"b".repeat(22)}`);
const refused = err({ code: "SERVICE_UNAVAILABLE" });

test.each([
    [0, 0, ok(null)],
    [MAX_STREAMS_PER_ACCOUNT - 1, 10, ok(null)],
    [MAX_STREAMS_PER_ACCOUNT, 10, refused],
    [0, MAX_STREAMS - 1, ok(null)],
    [0, MAX_STREAMS, refused],
    [MAX_STREAMS_PER_ACCOUNT, MAX_STREAMS, refused],
] as const)(
    "a stream with %d of the account's open and %d overall",
    (accountStreams, totalStreams, expected) => {
        expect(decideStreamAdmission({ accountStreams, totalStreams })).toEqual(expected);
    },
);

// A scheduler the test runs by hand.
function manual() {
    const queued: (() => void)[] = [];
    return {
        schedule: (run: () => void) => {
            queued.push(run);
        },
        runAll: () => {
            for (const run of queued.splice(0)) run();
        },
        pending: () => queued.length,
    };
}

function recorder(onClose = () => {}) {
    const seen: number[] = [];
    let closed = 0;
    return {
        seen,
        closedCount: () => closed,
        end: {
            send: (event: PresenceEvent) => {
                seen.push(event.online);
                return true;
            },
            close: () => {
                closed += 1;
                onClose();
            },
        },
    };
}

test("presence counts accounts, is sent to everyone once per coalescing delay, and caps streams per account", () => {
    const timer = manual();
    const hub = createEventHub({ schedule: timer.schedule });
    const first = recorder();
    const second = recorder();
    const third = recorder();
    expect(hub.connect(alice, first.end).ok).toBe(true);
    expect(hub.connect(bob, second.end).ok).toBe(true);
    // Each joiner is told the count at once; everyone else waits for the one broadcast.
    expect(first.seen).toEqual([1]);
    expect(second.seen).toEqual([2]);
    expect(timer.pending()).toBe(1);
    timer.runAll();
    expect(first.seen).toEqual([1, 2]);
    expect(second.seen).toEqual([2, 2]);
    // A second tab of an account changes nothing.
    expect(hub.connect(alice, third.end).ok).toBe(true);
    expect(timer.pending()).toBe(0);
    expect(hub.online()).toBe(2);

    const extra = Array.from({ length: MAX_STREAMS_PER_ACCOUNT - 2 }, () =>
        hub.connect(alice, recorder().end),
    );
    expect(extra.every((joined) => joined.ok)).toBe(true);
    expect(hub.connect(alice, recorder().end)).toEqual(refused);
    expect(hub.connect(bob, recorder().end).ok).toBe(true);
});

test("a stream that cannot take an event is dropped and closed, and leaving the last stream changes presence", () => {
    const timer = manual();
    const hub = createEventHub({ schedule: timer.schedule });
    const watcher = recorder();
    hub.connect(alice, watcher.end);
    const stuck = recorder();
    const stream = { ...stuck.end, send: () => false };
    hub.connect(bob, stream);
    expect(stuck.closedCount()).toBe(1);
    expect(hub.online()).toBe(1);
    timer.runAll();
    const leave = hub.connect(bob, recorder().end);
    invariant(leave.ok, "expected a stream");
    timer.runAll();
    expect(watcher.seen.at(-1)).toBe(2);
    leave.value();
    timer.runAll();
    expect(watcher.seen.at(-1)).toBe(1);
});

test("closing the hub ends every stream and refuses new ones", () => {
    const hub = createEventHub({ schedule: () => {} });
    const one = recorder();
    const two = recorder();
    hub.connect(alice, one.end);
    hub.connect(bob, two.end);
    hub.close();
    expect([one.closedCount(), two.closedCount()]).toEqual([1, 1]);
    expect(hub.online()).toBe(0);
    expect(hub.connect(alice, recorder().end)).toEqual(refused);
});

async function readUntil(
    reader: {
        readonly read: () => Promise<{
            readonly done: boolean;
            readonly value?: Uint8Array | undefined;
        }>;
    },
    text: string,
) {
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += decoder.decode(chunk.value);
    }
    return seen;
}

test("a member's stream carries presence, ends with its session or a superseded instance, and refuses a stranger", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9601);
        let superseded = false;
        const hub = createEventHub({ schedule: () => {} });
        const app = new Hono();
        mountCommunityEvents(app, { db, hub, isSuperseded: () => superseded, heartbeatMs: 25 });
        const open = (session: string | null) =>
            app.fetch(
                new Request("http://localhost/internal/web/events", {
                    headers: session === null ? {} : { "lucent-session": session },
                }),
            );
        expect((await open(null)).status).toBe(400);
        expect((await open("x".repeat(43))).status).toBe(401);

        const first = await member(db, rng, "alice@lucent.test", "alice");
        const response = await open(first.token);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        const reader = response.body?.getReader();
        invariant(reader !== undefined, "expected a stream");
        expect(await readUntil(reader, "event: presence")).toContain('data: {"online":1,"roster":');
        expect(hub.online()).toBe(1);

        // The session ends: the next heartbeat closes the stream and the account goes offline.
        await execute(db, sql`delete from browser_session where account_id = ${first.id}`);
        expect(await readUntil(reader, "never arrives")).not.toContain("never arrives");
        expect(hub.online()).toBe(0);

        // A superseded instance closes its streams on the next heartbeat.
        const second = await member(db, rng, "bob@lucent.test", "bob");
        const live = await open(second.token);
        const liveReader = live.body?.getReader();
        invariant(liveReader !== undefined, "expected a stream");
        await readUntil(liveReader, "event: presence");
        superseded = true;
        expect(await readUntil(liveReader, "never arrives")).not.toContain("never arrives");
        expect(hub.online()).toBe(0);
        expect((await open(second.token)).status).toBe(503);
    });
});

test("a stop with a stream open returns once the hub ends it", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9602);
        const hub = createEventHub();
        const app = new Hono();
        mountCommunityEvents(app, { db, hub, isSuperseded: () => false, heartbeatMs: 60_000 });
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        const who = await member(db, rng, "alice@lucent.test", "alice");
        const response = await fetch(`http://localhost:${server.port}/internal/web/events`, {
            headers: { "lucent-session": who.token },
        });
        const reader = response.body?.getReader();
        invariant(reader !== undefined, "expected a stream");
        await readUntil(reader, "event: presence");
        hub.close();
        const stopped = await Promise.race([
            server.stop().then(() => "stopped"),
            Bun.sleep(3_000).then(() => "hung"),
        ]);
        expect(stopped).toBe("stopped");
        expect(await readUntil(reader, "never arrives")).not.toContain("never arrives");
    });
});
