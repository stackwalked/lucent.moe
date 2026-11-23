import { expect, test } from "bun:test";
import { invariant } from "@lucent/core/contain";
import { createSeededRng } from "@lucent/core/rng";
import { AccountId } from "@lucent/core/scalars";
import { Hono } from "hono";
import { createEventHub } from "../src/community/events.ts";
import { execute, sql } from "../src/db/pool.ts";
import { mountCommunityEvents } from "../src/listeners/internal/events.ts";
import { member } from "./community-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const alice = AccountId.parse(`acc_${"a".repeat(22)}`);
const bob = AccountId.parse(`acc_${"b".repeat(22)}`);

test("presence counts accounts, not streams, and a stream that fails is dropped", () => {
    const hub = createEventHub();
    const seen: string[] = [];
    const leaveFirst = hub.connect(alice, (event) => seen.push(JSON.stringify(event)));
    const leaveSecond = hub.connect(alice, () => {});
    const leaveBob = hub.connect(bob, () => {
        JSON.parse("{");
    });
    // Two tabs of one account are one online; the failing stream left at its first send.
    expect(hub.online()).toBe(1);
    expect(seen).toEqual([
        '{"kind":"presence","online":1}',
        '{"kind":"presence","online":1}',
        '{"kind":"presence","online":2}',
    ]);
    hub.publish({ kind: "shout" });
    expect(seen.at(-1)).toBe('{"kind":"shout"}');
    leaveSecond();
    expect(hub.online()).toBe(1);
    leaveFirst();
    leaveBob();
    expect(hub.online()).toBe(0);
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

test("a member's stream carries presence and pings, ends with its session, and refuses a stranger", async () => {
    const cluster = await sharedTestCluster();
    await cluster.withTestDb(async ({ browserDb: db }) => {
        const rng = createSeededRng(9601);
        const hub = createEventHub();
        const app = new Hono();
        mountCommunityEvents(app, { db, hub, isSuperseded: () => false, heartbeatMs: 25 });
        const open = (session: string | null, signal?: AbortSignal) =>
            app.fetch(
                new Request("http://localhost/internal/web/events", {
                    headers: session === null ? {} : { "lucent-session": session },
                    ...(signal === undefined ? {} : { signal }),
                }),
            );
        expect((await open(null)).status).toBe(400);
        expect((await open("x".repeat(43))).status).toBe(401);

        const alice = await member(db, rng, "alice@lucent.test", "alice");
        const stop = new AbortController();
        const response = await open(alice.token, stop.signal);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        const reader = response.body?.getReader();
        invariant(reader !== undefined, "expected a stream");
        expect(await readUntil(reader, "event: presence")).toContain('data: {"online":1}');
        expect(hub.online()).toBe(1);
        hub.publish({ kind: "comment" });
        expect(await readUntil(reader, "event: comment")).toContain("event: comment");

        // The session ends: the next heartbeat closes the stream and the account goes offline.
        await execute(db, sql`delete from browser_session where account_id = ${alice.id}`);
        const rest = await readUntil(reader, "never arrives");
        expect(rest).not.toContain("never arrives");
        expect(hub.online()).toBe(0);
        stop.abort();
    });
});
