import { containBoundary, invariant, tryAsync, trySync } from "@lucent/core/contain";
import { err, ok, type Result } from "@lucent/core/result";
import { BearerToken, ClientInfo } from "@lucent/core/scalars";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
    type ContractMap,
    isStrongPeerKey,
    MIN_PEER_KEY_LENGTH,
    type ProcedureContract,
    RequestId,
    RPC_HEADERS,
    type TransportRefusal,
} from "./contract.ts";

export const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;
type SessionFor<C extends ProcedureContract> = C["session"] extends "none" ? null : BearerToken;

// What the request carried besides its input. `client` is trusted because only web holds the
// peer key; it is null when the caller didn't send one (tests, tools).
export type CallInfo<C extends ProcedureContract> = {
    readonly session: SessionFor<C>;
    readonly client: ClientInfo | null;
};

export type Handler<Ctx, C extends ProcedureContract> = (
    ctx: Ctx,
    input: z.output<C["input"]>,
    call: CallInfo<C>,
) => Promise<Result<z.output<C["output"]>, z.output<C["error"]>>>;

export type Handlers<Ctx, Contracts extends ContractMap> = {
    readonly [K in keyof Contracts]: Handler<Ctx, Contracts[K]>;
};

type BoundProcedure<Ctx> = {
    readonly contract: ProcedureContract;
    // biome-ignore lint/suspicious/noExplicitAny: variance-erased handler; `implement` typed it against its contract
    readonly run: (ctx: Ctx, input: any, call: any) => Promise<Result<unknown, unknown>>;
};
export type ProcedureMap<Ctx> = ReadonlyMap<string, BoundProcedure<Ctx>>;

// Binds one handler to each procedure of a contract: a missing or extra handler, or one whose
// input, session or Result disagrees with its contract, doesn't compile.
export function implement<Ctx, Contracts extends ContractMap>(
    contracts: Contracts,
    handlers: Handlers<Ctx, Contracts>,
): ProcedureMap<Ctx> {
    const runs = new Map(Object.entries(handlers));
    const bound = new Map<string, BoundProcedure<Ctx>>();
    for (const [name, contract] of Object.entries(contracts)) {
        const run = runs.get(name);
        invariant(run !== undefined, `no handler for procedure ${name}`);
        bound.set(name, { contract, run });
    }
    return bound;
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const maxLen = Math.max(leftBytes.byteLength, rightBytes.byteLength);
    let diff = leftBytes.byteLength ^ rightBytes.byteLength;
    for (let i = 0; i < maxLen; i++) {
        const a = leftBytes[i] ?? 0;
        const b = rightBytes[i] ?? 0;
        diff |= a ^ b;
    }
    return diff === 0;
}

export async function readBoundedJson(
    req: Request,
    maxBytes = DEFAULT_BODY_LIMIT_BYTES,
): Promise<Result<unknown, TransportRefusal>> {
    const declared = req.headers.get("content-length");
    if (declared !== null) {
        const parsedLen = Number(declared);
        if (!Number.isFinite(parsedLen) || parsedLen > maxBytes) {
            return err({ code: "PAYLOAD_TOO_LARGE" });
        }
    }
    if (req.body === null) {
        return err({ code: "INVALID_REQUEST", detail: "empty body" });
    }
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    const streamRead = await tryAsync(
        async () => {
            for (;;) {
                const step = await reader.read();
                if (step.done) break;
                total += step.value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel();
                    return "too_large" as const;
                }
                chunks.push(step.value);
            }
            return "complete" as const;
        },
        () => ({ code: "INVALID_REQUEST" as const, detail: "failed reading request stream" }),
    );
    if (!streamRead.ok) return streamRead;
    if (streamRead.value === "too_large") {
        return err({ code: "PAYLOAD_TOO_LARGE" });
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return trySync(
        (): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)),
        () => ({ code: "INVALID_REQUEST" as const, detail: "malformed UTF-8 or JSON" }),
    );
}

const RpcEnvelopeSchema = z.strictObject({
    procedure: z.string().min(1).max(128),
    input: z.unknown(),
});

type FailureKind = "defect" | "exception";

export type UnhandledFailure = {
    readonly detail: string;
    readonly kind: FailureKind;
    readonly requestId: RequestId | null;
};

function requestIdOf(req: Request): RequestId | null {
    const parsed = RequestId.safeParse(req.headers.get(RPC_HEADERS.request));
    return parsed.success ? parsed.data : null;
}

function sessionFor(
    contract: ProcedureContract,
    req: Request,
): Result<BearerToken | null, TransportRefusal> {
    if (contract.session === "none") return ok(null);
    const parsed = BearerToken.safeParse(req.headers.get(RPC_HEADERS.session));
    if (parsed.success) return ok(parsed.data);
    return err({ code: "INVALID_REQUEST", detail: "missing or malformed Lucent-Session" });
}

function clientFor(req: Request): Result<ClientInfo | null, TransportRefusal> {
    const header = req.headers.get(RPC_HEADERS.client);
    if (header === null) return ok(null);
    const malformed = { code: "INVALID_REQUEST" as const, detail: "malformed Lucent-Client" };
    const decoded = trySync(
        (): unknown =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(header, { alphabet: "base64url" }),
                ),
            ),
        () => malformed,
    );
    if (!decoded.ok) return decoded;
    const parsed = ClientInfo.safeParse(decoded.value);
    return parsed.success ? ok(parsed.data) : err(malformed);
}

export function mountInternalRpc<Ctx>(params: {
    readonly path: string;
    readonly peerKey: string;
    readonly procedures: ProcedureMap<Ctx>;
    readonly createContext: (req: Request) => Promise<Result<Ctx, TransportRefusal>>;
    readonly onUnhandledError: (failure: UnhandledFailure) => void;
    readonly maxBodyBytes?: number;
}): Hono {
    invariant(
        isStrongPeerKey(params.peerKey),
        `internal peer key must be at least ${MIN_PEER_KEY_LENGTH} visible ASCII characters`,
    );
    const app = new Hono();
    const bodyLimit = params.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    const expectedAuth = `Bearer ${params.peerKey}`;

    // The answer to anything uncontained, so it must not throw itself: a failing logger is dropped.
    const unavailable = async (c: Context, detail: string, kind: FailureKind) => {
        const requestId = requestIdOf(c.req.raw);
        await containBoundary({
            run: () => Promise.resolve(params.onUnhandledError({ detail, kind, requestId })),
            onUnhandled: () => undefined,
        });
        return c.json(err<TransportRefusal>({ code: "SERVICE_UNAVAILABLE" }), 503);
    };

    // Hono routes thrown Errors to onError but rethrows anything else (invariant defects are plain
    // objects) out of fetch, where Bun answers 500; the outermost middleware below contains those.
    app.onError((cause, c) => unavailable(c, cause.message, "exception"));
    app.use("*", async (c, next) => {
        const contained = await containBoundary({
            run: async () => {
                await next();
                return null;
            },
            onUnhandled: (detail, kind) => unavailable(c, detail, kind),
        });
        return contained ?? undefined;
    });

    app.use("*", async (c, next) => {
        c.header("cache-control", "no-store");
        const auth = c.req.header("authorization") ?? "";
        if (!timingSafeEqualStrings(auth, expectedAuth)) {
            return c.json(err<TransportRefusal>({ code: "AUTH_REQUIRED" }), 401);
        }
        return await next();
    });

    app.post(params.path, async (c) => {
        const rawResult = await readBoundedJson(c.req.raw, bodyLimit);
        if (!rawResult.ok) {
            const status = rawResult.error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
            return c.json(rawResult, status);
        }
        const envelope = RpcEnvelopeSchema.safeParse(rawResult.value);
        if (!envelope.success) {
            return c.json(
                err<TransportRefusal>({ code: "INVALID_REQUEST", detail: "invalid RPC envelope" }),
                400,
            );
        }
        const name = envelope.data.procedure;
        const target = params.procedures.get(name);
        if (target === undefined) {
            return c.json(err<TransportRefusal>({ code: "UNKNOWN_PROCEDURE" }), 404);
        }
        const { contract } = target;
        const parsedInput = contract.input.safeParse(envelope.data.input);
        if (!parsedInput.success) {
            return c.json(
                err<TransportRefusal>({
                    code: "INVALID_REQUEST",
                    detail: parsedInput.error.issues[0]?.message ?? "invalid input",
                }),
                400,
            );
        }
        const session = sessionFor(contract, c.req.raw);
        if (!session.ok) return c.json(session, 400);
        const client = clientFor(c.req.raw);
        if (!client.ok) return c.json(client, 400);
        const ctxRes = await params.createContext(c.req.raw);
        if (!ctxRes.ok) {
            const status = ctxRes.error.code === "SERVICE_UNAVAILABLE" ? 503 : 401;
            return c.json(ctxRes, status);
        }
        const result = await target.run(ctxRes.value, parsedInput.data, {
            session: session.value,
            client: client.value,
        });
        // The reply leaves through the contract's own schemas: a field a handler added by accident
        // is dropped, and one that breaks the contract is a defect, not a reply.
        const reply = result.ok
            ? contract.output.safeParse(result.value)
            : contract.error.safeParse(result.error);
        if (!reply.success) {
            return await unavailable(c, `${name} replied outside its contract`, "defect");
        }
        return c.json(result.ok ? ok(reply.data) : err(reply.data), 200);
    });

    return app;
}
