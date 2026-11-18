import { expect, test } from "bun:test";
import { z } from "zod";
import { containBoundary, invariant } from "../src/core/contain.ts";
import { err, ok } from "../src/core/result.ts";
import { createRpcClient, mountInternalRpc, procedure } from "../src/core/rpc.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const ENDPOINT = "http://localhost/internal/web/rpc";

const procedures = {
    "math.double": procedure({
        input: z.strictObject({ n: z.number().int() }),
        output: z.strictObject({ doubled: z.number().int() }),
        error: z.strictObject({ code: z.literal("NEGATIVE_INPUT") }),
        run: (_ctx: unknown, { n }) => {
            if (n < 0) return Promise.resolve(err({ code: "NEGATIVE_INPUT" as const }));
            return Promise.resolve(ok({ doubled: n * 2 }));
        },
    }),
    "bug.defect": procedure({
        input: z.strictObject({}),
        output: z.strictObject({}),
        error: z.never(),
        run: () => {
            invariant(false, "simulated programmer bug");
        },
    }),
};

function mount(overrides?: {
    readonly createContext?: () => Promise<{ readonly ok: true; readonly value: unknown }>;
    readonly onUnhandledError?: () => void;
}) {
    return mountInternalRpc({
        path: "/internal/web/rpc",
        peerKey: PEER_KEY,
        procedures,
        maxBodyBytes: 256,
        createContext: overrides?.createContext ?? (() => Promise.resolve(ok(null))),
        onUnhandledError: overrides?.onUnhandledError ?? (() => {}),
    });
}

function clientFor(app: ReturnType<typeof mount>, peerKey = PEER_KEY) {
    return createRpcClient(procedures, {
        endpointUrl: ENDPOINT,
        peerKey,
        fetcher: async (req) => await app.fetch(req),
    });
}

function rpcRequest(init: {
    readonly body: string | ReadableStream<Uint8Array>;
    readonly headers?: Record<string, string>;
}) {
    return new Request(ENDPOINT, {
        method: "POST",
        headers: {
            authorization: `Bearer ${PEER_KEY}`,
            "content-type": "application/json",
            ...init.headers,
        },
        body: init.body,
    });
}

test("mounting refuses a peer key shorter than 43 characters", async () => {
    const outcome = await containBoundary({
        run: () =>
            Promise.resolve(
                mountInternalRpc({
                    path: "/internal/web/rpc",
                    peerKey: "x".repeat(42),
                    procedures,
                    createContext: () => Promise.resolve(ok(null)),
                    onUnhandledError: () => {},
                }),
            ),
        onUnhandled: (_detail, failureKind) => failureKind,
    });
    expect(outcome).toBe("defect");
});

test("a caller without the peer key is refused before any procedure runs", async () => {
    const res = await clientFor(mount(), "wrong-key").call("math.double", { n: 4 });
    expect(res).toEqual(err({ code: "AUTH_REQUIRED" }));
});

test("a procedure's ok value reaches the client", async () => {
    expect(await clientFor(mount()).call("math.double", { n: 21 })).toEqual(ok({ doubled: 42 }));
});

test("a procedure's domain error reaches the client as err", async () => {
    expect(await clientFor(mount()).call("math.double", { n: -1 })).toEqual(
        err({ code: "NEGATIVE_INPUT" }),
    );
});

test("an invariant defect in a procedure answers 503", async () => {
    const res = await mount().fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "bug.defect", input: {} }) }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(err({ code: "SERVICE_UNAVAILABLE" }));
});

test("an exception thrown outside a procedure answers 503, not 500", async () => {
    const app = mount({ createContext: () => Promise.resolve(ok(JSON.parse("{"))) });
    const res = await app.fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "math.double", input: { n: 1 } }) }),
    );
    expect(res.status).toBe(503);
});

test("a failing error logger still answers 503", async () => {
    const app = mount({ onUnhandledError: () => JSON.parse("{") });
    const res = await app.fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "bug.defect", input: {} }) }),
    );
    expect(res.status).toBe(503);
});

test("input with an unknown field is refused with 400", async () => {
    const res = await mount().fetch(
        rpcRequest({
            body: JSON.stringify({ procedure: "math.double", input: { n: 2, extra: true } }),
        }),
    );
    expect(res.status).toBe(400);
});

test("a declared Content-Length over the limit is refused with 413 without reading the body", async () => {
    let pulled = false;
    const neverEnding = new ReadableStream<Uint8Array>(
        {
            pull() {
                pulled = true;
            },
        },
        { highWaterMark: 0 },
    );
    const res = await mount().fetch(
        rpcRequest({ body: neverEnding, headers: { "content-length": "100000" } }),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBe(false);
});

test("a streamed body over the limit is refused with 413 before it is buffered", async () => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(200).fill(65));
            controller.enqueue(new Uint8Array(200).fill(65));
            controller.close();
        },
    });
    const res = await mount().fetch(rpcRequest({ body: stream }));
    expect(res.status).toBe(413);
});

test("the client treats a reply that does not match the procedure's schemas as unavailable", async () => {
    const client = createRpcClient(procedures, {
        endpointUrl: ENDPOINT,
        peerKey: PEER_KEY,
        fetcher: () => Promise.resolve(Response.json(ok({ doubled: "forty-two" }))),
    });
    expect(await client.call("math.double", { n: 21 })).toEqual(
        err({ code: "SERVICE_UNAVAILABLE" }),
    );
});
