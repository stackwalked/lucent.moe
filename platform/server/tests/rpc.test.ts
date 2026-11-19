import { expect, test } from "bun:test";
import { z } from "zod";
import { containBoundary, invariant } from "../src/core/contain.ts";
import { err, ok } from "../src/core/result.ts";
import {
    createRpcClient,
    defineContract,
    implement,
    mountInternalRpc,
    RequestId,
    type UnhandledFailure,
} from "../src/core/rpc.ts";
import { BearerToken, ClientInfo } from "../src/core/scalars.ts";

const PEER_KEY = "test-peer-key-0123456789abcdefghijklmnopqrstuvwxyz";
const ENDPOINT = "http://localhost/internal/web/rpc";
const SESSION = BearerToken.parse("s".repeat(43));

const contract = defineContract({
    "math.double": {
        session: "none",
        input: z.strictObject({ n: z.number().int() }),
        output: z.object({ doubled: z.number().int() }),
        error: z.object({ code: z.literal("NEGATIVE_INPUT") }),
    },
    "session.echo": {
        session: "member",
        input: z.strictObject({}),
        output: z.object({ session: z.string() }),
        error: z.never(),
    },
    "client.echo": {
        session: "none",
        input: z.strictObject({}),
        output: z.object({ ip: z.string().nullable() }),
        error: z.never(),
    },
    "leak.extra": {
        session: "none",
        input: z.strictObject({}),
        output: z.object({ shown: z.string() }),
        error: z.never(),
    },
    "bug.offContract": {
        session: "none",
        input: z.strictObject({}),
        output: z.object({ count: z.number() }),
        error: z.never(),
    },
    "bug.defect": {
        session: "none",
        input: z.strictObject({}),
        output: z.object({}),
        error: z.never(),
    },
});

const procedures = implement<unknown, typeof contract>(contract, {
    "math.double": (_ctx, { n }) => {
        if (n < 0) return Promise.resolve(err({ code: "NEGATIVE_INPUT" as const }));
        return Promise.resolve(ok({ doubled: n * 2 }));
    },
    "session.echo": (_ctx, _input, { session }) => Promise.resolve(ok({ session })),
    "client.echo": (_ctx, _input, { client }) => Promise.resolve(ok({ ip: client?.ip ?? null })),
    "leak.extra": () => {
        const row = { shown: "yes", tokenHash: "never on the wire" };
        return Promise.resolve(ok(row));
    },
    "bug.offContract": () => Promise.resolve(ok(JSON.parse('{"count":"many"}'))),
    "bug.defect": () => {
        invariant(false, "simulated programmer bug");
    },
});

function mount(overrides?: {
    readonly createContext?: () => Promise<{ readonly ok: true; readonly value: unknown }>;
    readonly onUnhandledError?: (failure: UnhandledFailure) => void;
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
    return createRpcClient(contract, {
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

test("a procedure that needs a session is refused without Lucent-Session before its handler runs", async () => {
    const res = await mount().fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "session.echo", input: {} }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
        err({ code: "INVALID_REQUEST", detail: "missing or malformed Lucent-Session" }),
    );
});

test("the client sends the session in Lucent-Session and the handler receives it", async () => {
    const reply = await clientFor(mount()).call("session.echo", {}, { session: SESSION });
    expect(reply).toEqual(ok({ session: SESSION }));
});

test("the client web reports in Lucent-Client reaches the handler", async () => {
    const client = ClientInfo.parse({ ip: "198.51.100.4", userAgent: "Lynx é" });
    const reply = await clientFor(mount()).call("client.echo", {}, { client });
    expect(reply).toEqual(ok({ ip: "198.51.100.4" }));
    expect(await clientFor(mount()).call("client.echo", {})).toEqual(ok({ ip: null }));
});

test("a malformed Lucent-Client is refused with 400", async () => {
    for (const header of ["not base64url!", "e30", btoa('{"ip":"999.1.1.1","userAgent":""}')]) {
        const res = await mount().fetch(
            rpcRequest({
                body: JSON.stringify({ procedure: "client.echo", input: {} }),
                headers: { "lucent-client": header },
            }),
        );
        expect({ header, status: res.status }).toEqual({ header, status: 400 });
    }
});

test("a field a handler returns outside its contract never reaches the wire", async () => {
    const res = await mount().fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "leak.extra", input: {} }) }),
    );
    expect(await res.json()).toEqual(ok({ shown: "yes" }));
});

test("a reply that breaks its contract answers 503 and is logged as a defect", async () => {
    const failures: UnhandledFailure[] = [];
    const res = await mount({ onUnhandledError: (failure) => failures.push(failure) }).fetch(
        rpcRequest({
            body: JSON.stringify({ procedure: "bug.offContract", input: {} }),
            headers: { "lucent-request": "req-0123456789" },
        }),
    );
    expect(res.status).toBe(503);
    expect(failures).toEqual([
        {
            detail: "bug.offContract replied outside its contract",
            kind: "defect",
            requestId: RequestId.parse("req-0123456789"),
        },
    ]);
});

test("an Object.prototype name is an unknown procedure", async () => {
    const res = await mount().fetch(
        rpcRequest({ body: JSON.stringify({ procedure: "toString", input: {} }) }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(err({ code: "UNKNOWN_PROCEDURE" }));
});
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
    const client = createRpcClient(contract, {
        endpointUrl: ENDPOINT,
        peerKey: PEER_KEY,
        fetcher: () => Promise.resolve(Response.json(ok({ doubled: "forty-two" }))),
    });
    expect(await client.call("math.double", { n: 21 })).toEqual(
        err({ code: "SERVICE_UNAVAILABLE" }),
    );
});
