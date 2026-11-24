import { createRpcClient, type RpcClient } from "@lucent/rpc/client";
import { type WebContract, webContract } from "@lucent/rpc/web";
import type { PlatformAddress } from "./config.ts";

// The RPC client for platform's internal listener, over loopback HTTP or its Unix socket.
export function connectPlatform(address: PlatformAddress, peerKey: string): RpcClient<WebContract> {
    if (address.kind === "http") {
        return createRpcClient(webContract, {
            endpointUrl: `${address.origin}/internal/web/rpc`,
            peerKey,
        });
    }
    return createRpcClient(webContract, {
        endpointUrl: "http://platform/internal/web/rpc",
        peerKey,
        fetcher: (req) => fetch(req, { unix: address.path }),
    });
}

// A request to one of platform's streaming routes (the loader and resource downloads, resource
// uploads), carrying the peer key like every RPC: a GET, or a POST of `body`. Bodies both ways are
// handed on as they arrive.
export type PlatformGet = (
    path: string,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
    body?: ReadableStream<Uint8Array>,
) => Promise<Response>;

export function connectPlatformStreams(address: PlatformAddress, peerKey: string): PlatformGet {
    return async (path, headers, signal, body) => {
        const init = {
            headers: { ...headers, authorization: `Bearer ${peerKey}` },
            signal,
            ...(body === undefined ? {} : { method: "POST", body, duplex: "half" as const }),
        };
        if (address.kind === "http") return await fetch(`${address.origin}${path}`, init);
        return await fetch(`http://platform${path}`, { ...init, unix: address.path });
    };
}
