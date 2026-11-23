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

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// The internal listener's other streaming route: one SSE stream per signed-in browser tab, carrying
// presence and community pings (community/events.ts). The session is read again on every
// heartbeat, so a stream outlives neither its session nor its account's sign-out. Web holds the
// browser's connection; this is the leg behind it, behind the same peer-key check.
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
        let leave = () => {};
        let beat: ReturnType<typeof setInterval> | undefined;
        const stop = () => {
            clearInterval(beat);
            leave();
        };
        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                leave = deps.hub.connect(session.value.accountId, (event) => {
                    const { kind, ...data } = event;
                    controller.enqueue(frame(kind, data));
                });
                // Unref'd, like the jobs: a timer alone never keeps the process alive.
                beat = setInterval(() => {
                    void sessionOf(token.data).then((again) => {
                        if (again.ok) return controller.enqueue(encoder.encode(": heartbeat\n\n"));
                        stop();
                        controller.close();
                    });
                }, deps.heartbeatMs);
                beat.unref();
            },
            cancel: stop,
        });
        c.req.raw.signal.addEventListener("abort", stop);
        return new Response(body, {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-store",
                "x-accel-buffering": "no",
            },
        });
    });
}
