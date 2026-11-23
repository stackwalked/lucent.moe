import { trySync } from "@lucent/core/contain";
import { err } from "@lucent/core/result";
import { BearerToken } from "@lucent/core/scalars";
import { RPC_HEADERS } from "@lucent/rpc/contract";
import { COMMUNITY_EVENTS_PATH } from "@lucent/rpc/web";
import type { Hono } from "hono";
import { readSession } from "../../auth/sessions.ts";
import type { EventHub } from "../../community/events.ts";
import type { Db } from "../../db/pool.ts";
import { withTx } from "../../db/tx.ts";

function refusal(code: string, status: 400 | 401 | 503): Response {
    return Response.json(err({ code }), { status, headers: { "cache-control": "no-store" } });
}

// Frames a slow reader may leave unread before its stream is dropped.
const MAX_QUEUED_FRAMES = 16;

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// The internal listener's other streaming route: one SSE stream per signed-in browser tab, carrying
// presence (community/events.ts). Every heartbeat reads the session again and checks the instance
// is still the live one, so a stream outlives neither its session nor its instance; the hub ends
// all of them when the server stops. Web holds the browser's connection; this is the leg behind
// it, behind the same peer-key check.
export function mountCommunityEvents(
    app: Hono,
    deps: {
        readonly db: Db;
        readonly hub: EventHub;
        readonly isSuperseded: () => boolean;
        readonly heartbeatMs: number;
    },
): void {
    const sessionOf = (token: BearerToken) =>
        withTx(deps.db, (tx, txNow) => readSession(tx, { token, txNow, purposes: ["member"] }));

    app.get(COMMUNITY_EVENTS_PATH, async (c) => {
        if (deps.isSuperseded()) return refusal("SERVICE_UNAVAILABLE", 503);
        const token = BearerToken.safeParse(c.req.header(RPC_HEADERS.session));
        if (!token.success) return refusal("INVALID_REQUEST", 400);
        const session = await sessionOf(token.data);
        if (!session.ok) {
            return session.error.code === "SESSION_INVALID"
                ? refusal("SESSION_INVALID", 401)
                : refusal("SERVICE_UNAVAILABLE", 503);
        }
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let leave = () => {};
        let beat: ReturnType<typeof setInterval> | undefined;
        let ended = false;
        // Whoever ends the stream first (the client, the hub, a heartbeat) runs this; the rest
        // find it done. Nothing after it touches the controller.
        const end = () => {
            if (ended) return;
            ended = true;
            clearInterval(beat);
            leave();
            const target = controller;
            if (target !== undefined)
                trySync(
                    () => target.close(),
                    () => "already closed",
                );
        };
        const body = new ReadableStream<Uint8Array>(
            {
                start: (started) => {
                    controller = started;
                },
                cancel: end,
            },
            { highWaterMark: MAX_QUEUED_FRAMES },
        );
        const joined = deps.hub.connect(session.value.accountId, {
            send: (event) => {
                const target = controller;
                if (ended || target === undefined) return false;
                // A reader that is not keeping up is dropped, not buffered for without limit.
                if (target.desiredSize === null || target.desiredSize <= 0) return false;
                const { kind, ...data } = event;
                const queued = trySync(
                    () => target.enqueue(frame(kind, data)),
                    () => "closed",
                );
                return queued.ok;
            },
            close: end,
        });
        if (!joined.ok) {
            end();
            return refusal("SERVICE_UNAVAILABLE", 503);
        }
        leave = joined.value;
        // Unref'd, like the jobs: a timer alone never keeps the process alive.
        beat = setInterval(() => {
            if (deps.isSuperseded()) return end();
            void sessionOf(token.data).then((again) => {
                if (ended) return;
                if (!again.ok) return end();
                const target = controller;
                if (target === undefined) return;
                trySync(
                    () => target.enqueue(encoder.encode(": heartbeat\n\n")),
                    () => end(),
                );
            });
        }, deps.heartbeatMs);
        beat.unref();
        c.req.raw.signal.addEventListener("abort", end);
        return new Response(body, {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-store",
                "x-accel-buffering": "no",
            },
        });
    });
}
