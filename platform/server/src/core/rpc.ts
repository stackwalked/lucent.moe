import { type Context, Hono } from "hono";
import { z } from "zod";
import { containBoundary, invariant, tryAsync, trySync } from "./contain.ts";
import { err, type Result } from "./result.ts";

export const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

// 43 base64url characters hold 256 bits, what `openssl rand -base64 32` produces; a shorter key
// cannot carry that strength in any printable alphabet we would generate it in. Visible ASCII
// only: HTTP trims header whitespace, so a key with an edge space could never match.
const MIN_PEER_KEY_LENGTH = 43;
const PEER_KEY_ALPHABET = /^[\x21-\x7e]+$/;

export const TransportRefusal = z.discriminatedUnion("code", [
    z.strictObject({ code: z.literal("AUTH_REQUIRED") }),
    z.strictObject({ code: z.literal("PAYLOAD_TOO_LARGE") }),
    z.strictObject({ code: z.literal("INVALID_REQUEST"), detail: z.string() }),
    z.strictObject({ code: z.literal("UNKNOWN_PROCEDURE") }),
    z.strictObject({ code: z.literal("SERVICE_UNAVAILABLE") }),
]);
export type TransportRefusal = z.output<typeof TransportRefusal>;

// The schemas a caller needs to send a procedure's input and parse its Result.
export type ProcedureContract = {
    readonly input: z.ZodType;
    readonly output: z.ZodType;
    readonly error: z.ZodType;
};

export type Procedure<
    Ctx,
    Input extends z.ZodType,
    Output extends z.ZodType,
    Failure extends z.ZodType,
> = {
    readonly input: Input;
    readonly output: Output;
    readonly error: Failure;
    readonly run: (
        ctx: Ctx,
        input: z.output<Input>,
    ) => Promise<Result<z.output<Output>, z.output<Failure>>>;
};

export function procedure<
    Ctx,
    Input extends z.ZodType,
    Output extends z.ZodType,
    Failure extends z.ZodType,
>(spec: Procedure<Ctx, Input, Output, Failure>): Procedure<Ctx, Input, Output, Failure> {
    return spec;
}

export type AnyProcedure<Ctx> = ProcedureContract & {
    // biome-ignore lint/suspicious/noExplicitAny: variance-erased constraint for heterogeneous procedure maps
    readonly run: (ctx: Ctx, input: any) => Promise<Result<unknown, unknown>>;
};
export type ProcedureMap<Ctx> = Readonly<Record<string, AnyProcedure<Ctx>>>;

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
        () => {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
            return JSON.parse(text) as unknown;
        },
        () => ({ code: "INVALID_REQUEST" as const, detail: "malformed UTF-8 or JSON" }),
    );
}

const RpcEnvelopeSchema = z.strictObject({
    procedure: z.string().min(1).max(128),
    input: z.unknown(),
});

type FailureKind = "defect" | "exception";

export function mountInternalRpc<Ctx, MapType extends ProcedureMap<Ctx>>(params: {
    readonly path: string;
    readonly peerKey: string;
    readonly procedures: MapType;
    readonly createContext: (req: Request) => Promise<Result<Ctx, TransportRefusal>>;
    readonly onUnhandledError: (detail: string, failureKind: FailureKind) => void;
    readonly maxBodyBytes?: number;
}): Hono {
    invariant(
        params.peerKey.length >= MIN_PEER_KEY_LENGTH && PEER_KEY_ALPHABET.test(params.peerKey),
        `internal peer key must be at least ${MIN_PEER_KEY_LENGTH} visible ASCII characters`,
    );
    const app = new Hono();
    const bodyLimit = params.maxBodyBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    const expectedAuth = `Bearer ${params.peerKey}`;

    // The answer to anything uncontained, so it must not throw itself: a failing logger is dropped.
    const unavailable = async (c: Context, detail: string, kind: FailureKind) => {
        await containBoundary({
            run: () => Promise.resolve(params.onUnhandledError(detail, kind)),
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
        const target = params.procedures[envelope.data.procedure];
        if (target === undefined) {
            return c.json(err<TransportRefusal>({ code: "UNKNOWN_PROCEDURE" }), 404);
        }
        const parsedInput = target.input.safeParse(envelope.data.input);
        if (!parsedInput.success) {
            return c.json(
                err<TransportRefusal>({
                    code: "INVALID_REQUEST",
                    detail: parsedInput.error.issues[0]?.message ?? "invalid input",
                }),
                400,
            );
        }
        const ctxRes = await params.createContext(c.req.raw);
        if (!ctxRes.ok) {
            const status = ctxRes.error.code === "SERVICE_UNAVAILABLE" ? 503 : 401;
            return c.json(ctxRes, status);
        }
        return c.json(await target.run(ctxRes.value, parsedInput.data), 200);
    });

    return app;
}

type ContractMap = Readonly<Record<string, ProcedureContract>>;

export type RpcClient<Contracts extends ContractMap> = {
    readonly call: <K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        options?: {
            readonly signal?: AbortSignal;
            readonly headers?: Readonly<Record<string, string>>;
        },
    ) => Promise<
        Result<z.output<Contracts[K]["output"]>, z.output<Contracts[K]["error"]> | TransportRefusal>
    >;
};

// A reply is untrusted bytes like any other: it is parsed against the procedure's schemas, and
// anything that does not parse is the server being unavailable.
export function createRpcClient<Contracts extends ContractMap>(
    contracts: Contracts,
    config: {
        readonly endpointUrl: string;
        readonly peerKey: string;
        readonly defaultTimeoutMs?: number;
        readonly fetcher?: (req: Request) => Promise<Response>;
    },
): RpcClient<Contracts> {
    const timeoutMs = config.defaultTimeoutMs ?? 5_000;
    const send = config.fetcher ?? ((req: Request) => fetch(req));
    const unavailable = err<TransportRefusal>({ code: "SERVICE_UNAVAILABLE" });

    return {
        async call(name, input, options) {
            const contract = contracts[name];
            invariant(contract !== undefined, `no RPC contract for procedure ${name}`);
            const Reply = z.union([
                z.strictObject({ ok: z.literal(true), value: contract.output }),
                z.strictObject({
                    ok: z.literal(false),
                    error: z.union([contract.error, TransportRefusal]),
                }),
            ]);

            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const signal =
                options?.signal !== undefined
                    ? AbortSignal.any([options.signal, timeoutSignal])
                    : timeoutSignal;
            const req = new Request(config.endpointUrl, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${config.peerKey}`,
                    "content-type": "application/json",
                    ...(options?.headers ?? {}),
                },
                body: JSON.stringify({ procedure: name, input }),
                signal,
            });

            const bodyRes = await tryAsync(
                async (): Promise<unknown> => await (await send(req)).json(),
                () => unavailable,
            );
            if (!bodyRes.ok) return unavailable;
            const reply = Reply.safeParse(bodyRes.value);
            if (!reply.success) return unavailable;
            // Parsed by this procedure's own schemas; zod infers through the generic only as unknown.
            return reply.data as Result<
                z.output<(typeof contracts)[typeof name]["output"]>,
                z.output<(typeof contracts)[typeof name]["error"]> | TransportRefusal
            >;
        },
    };
}
