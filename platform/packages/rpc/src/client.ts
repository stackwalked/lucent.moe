import { invariant, tryAsync } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import type { BearerToken, ClientInfo } from "@lucent/core/scalars";
import { z } from "zod";
import {
    type ContractMap,
    type ProcedureContract,
    type RequestId,
    RPC_HEADERS,
    TransportRefusal,
    toClientHeader,
} from "./contract.ts";

export type CallOptions = {
    readonly signal?: AbortSignal;
    readonly requestId?: RequestId;
    readonly client?: ClientInfo;
};

type CallOptionsFor<C extends ProcedureContract> = C["session"] extends "none"
    ? [options?: CallOptions]
    : [options: CallOptions & { readonly session: BearerToken }];

export type ReplyOf<C extends ProcedureContract> = Result<
    z.output<C["output"]>,
    z.output<C["error"]> | TransportRefusal
>;

export type RpcClient<Contracts extends ContractMap> = {
    readonly call: <K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        ...options: CallOptionsFor<Contracts[K]>
    ) => Promise<ReplyOf<Contracts[K]>>;
    // For a gateway that decides the session at run time: it must be present exactly when the
    // procedure's contract needs one, which is checked instead of typed.
    readonly send: <K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        options: CallOptions & { readonly session: BearerToken | null },
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
    const transport = config.fetcher ?? ((req: Request) => fetch(req));
    const unavailable = err<TransportRefusal>({ code: "SERVICE_UNAVAILABLE" });

    async function invoke(
        name: string,
        input: unknown,
        options?: CallOptions & { readonly session?: BearerToken },
    ): Promise<Result<unknown, unknown>> {
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
        if (session !== undefined) headers.set(RPC_HEADERS.session, session);
        if (options?.requestId !== undefined) headers.set(RPC_HEADERS.request, options.requestId);
        if (options?.client !== undefined) {
            headers.set(RPC_HEADERS.client, toClientHeader(options.client));
        }
        const req = new Request(config.endpointUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ procedure: name, input }),
            signal,
        });

        const bodyRes = await tryAsync(
            async (): Promise<unknown> => await (await transport(req)).json(),
            () => unavailable,
        );
        if (!bodyRes.ok) return unavailable;
        const reply = Reply.safeParse(bodyRes.value);
        if (!reply.success) return unavailable;
        return reply.data;
    }

    // The overloads are what callers see; `invoke` works on what every procedure has in common.
    function call<K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        ...options: CallOptionsFor<Contracts[K]>
    ): Promise<ReplyOf<Contracts[K]>>;
    function call(
        name: string,
        input: unknown,
        options?: CallOptions & { readonly session?: BearerToken },
    ): Promise<Result<unknown, unknown>> {
        return invoke(name, input, options);
    }

    function send<K extends keyof Contracts & string>(
        name: K,
        input: z.input<Contracts[K]["input"]>,
        options: CallOptions & { readonly session: BearerToken | null },
    ): Promise<ReplyOf<Contracts[K]>>;
    function send(
        name: string,
        input: unknown,
        options: CallOptions & { readonly session: BearerToken | null },
    ): Promise<Result<unknown, unknown>> {
        const { session, ...rest } = options;
        return invoke(name, input, session === null ? rest : { ...rest, session });
    }

    return { call, send };
}
