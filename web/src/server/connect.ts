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
