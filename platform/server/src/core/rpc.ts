import { type Context, Hono } from "hono";
import { z } from "zod";
import { containBoundary, invariant, tryAsync, trySync } from "./contain.ts";
import { err, ok, type Result } from "./result.ts";
import { BearerToken, ClientInfo, toBase64Url } from "./scalars.ts";

export const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024;

// 43 base64url characters hold 256 bits, what `openssl rand -base64 32` produces; a shorter key
// cannot carry that strength in any printable alphabet we would generate it in. Visible ASCII
// only: HTTP trims header whitespace, so a key with an edge space could never match.
export const MIN_PEER_KEY_LENGTH = 43;
const PEER_KEY_ALPHABET = /^[\x21-\x7e]+$/;

export function isStrongPeerKey(key: string): boolean {
    return key.length >= MIN_PEER_KEY_LENGTH && PEER_KEY_ALPHABET.test(key);
}

const SESSION_HEADER = "lucent-session";
const CLIENT_HEADER = "lucent-client";
const REQUEST_HEADER = "lucent-request";

// Names one browser request across web's and platform's logs; web shows it as the support
// reference when something fails unexpectedly.
export const RequestId = z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .brand<"RequestId">();
export type RequestId = z.output<typeof RequestId>;

export const TransportRefusal = z.discriminatedUnion("code", [
    z.strictObject({ code: z.literal("AUTH_REQUIRED") }),
    z.strictObject({ code: z.literal("PAYLOAD_TOO_LARGE") }),
    z.strictObject({ code: z.literal("INVALID_REQUEST"), detail: z.string() }),
    z.strictObject({ code: z.literal("UNKNOWN_PROCEDURE") }),
    z.strictObject({ code: z.literal("SERVICE_UNAVAILABLE") }),
]);
export type TransportRefusal = z.output<typeof TransportRefusal>;

// Which browser session a procedure runs for. The mount refuses a call that lacks the token
// before any handler runs; the handler still locks and checks the session in its own
// transaction, which is what decides.
export type SessionNeed = "none" | "member" | "setup" | "either";

export type ProcedureContract = {
    readonly session: SessionNeed;
    readonly input: z.ZodType;
    readonly output: z.ZodType;
    readonly error: z.ZodType;
};
export type ContractMap = Readonly<Record<string, ProcedureContract>>;

export function defineContract<const Contracts extends ContractMap>(
    contracts: Contracts,
): Contracts {
    return contracts;
}

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

export type UnhandledFailure = {
    readonly detail: string;
    readonly kind: FailureKind;
    readonly requestId: RequestId | null;
};

function requestIdOf(req: Request): RequestId | null {
    const parsed = RequestId.safeParse(req.headers.get(REQUEST_HEADER));
    return parsed.success ? parsed.data : null;
}

function sessionFor(
    contract: ProcedureContract,
    req: Request,
): Result<BearerToken | null, TransportRefusal> {
    if (contract.session === "none") return ok(null);
    const parsed = BearerToken.safeParse(req.headers.get(SESSION_HEADER));
    if (parsed.success) return ok(parsed.data);
    return err({ code: "INVALID_REQUEST", detail: "missing or malformed Lucent-Session" });
}

// base64url of `{ ip, userAgent }` as JSON: a user agent may hold characters a header can't.
export function toClientHeader(client: ClientInfo): string {
    return toBase64Url(new TextEncoder().encode(JSON.stringify(client)));
}

function clientFor(req: Request): Result<ClientInfo | null, TransportRefusal> {
    const header = req.headers.get(CLIENT_HEADER);
    if (header === null) return ok(null);
    const malformed = { code: "INVALID_REQUEST" as const, detail: "malformed Lucent-Client" };
    const decoded = trySync(
        () =>
            JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.fromBase64(header, { alphabet: "base64url" }),
                ),
            ) as unknown,
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

type CallOptions = {
    readonly signal?: AbortSignal;
    readonly requestId?: RequestId;
    readonly client?: ClientInfo;
};

type CallOptionsFor<C extends ProcedureContract> = C["session"] extends "none"
    ? [options?: CallOptions]
    : [options: CallOptions & { readonly session: BearerToken }];

type ReplyOf<C extends ProcedureContract> = Result<
    z.output<C["output"]>,
    z.output<C["error"]> | TransportRefusal
>;

export type RpcClient<Contracts extends ContractMap> = {
    readonly call: <K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        ...options: CallOptionsFor<Contracts[K]>
    ) => Promise<ReplyOf<Contracts[K]>>;
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

    const call = async (
        name: string,
        input: unknown,
        options?: CallOptions & { readonly session?: BearerToken },
    ): Promise<Result<unknown, unknown>> => {
        const contract = contracts[name];
        invariant(contract !== undefined, `no RPC contract for procedure ${name}`);
        const session = options?.session;
        invariant(
            (contract.session === "none") === (session === undefined),
            `${name} is called with a session exactly when its contract needs one`,
        );
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
        const headers = new Headers({
            accept: "application/json",
            authorization: `Bearer ${config.peerKey}`,
            "content-type": "application/json",
        });
        if (session !== undefined) headers.set(SESSION_HEADER, session);
        if (options?.requestId !== undefined) headers.set(REQUEST_HEADER, options.requestId);
        if (options?.client !== undefined)
            headers.set(CLIENT_HEADER, toClientHeader(options.client));
        const req = new Request(config.endpointUrl, {
            method: "POST",
            headers,
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
        return reply.data;
    };

    // Parsed by the named procedure's own schemas; zod infers through the generic only as unknown.
    return { call } as RpcClient<Contracts>;
}
