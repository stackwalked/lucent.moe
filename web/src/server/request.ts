import type { AccountId, ClientInfo } from "@lucent/core/scalars";
import type { RequestId } from "@lucent/rpc/contract";
import type { Throttle } from "./throttle.ts";

// What one request accumulates for its log line: time spent waiting on platform, and whose
// session it carried once that's known.
export type RequestTrace = {
    readonly addPlatformTime: (ms: number) => void;
    readonly setAccount: (accountId: AccountId) => void;
    readonly read: () => { readonly platformMs: number; readonly accountId: AccountId | null };
};

export function createRequestTrace(): RequestTrace {
    let platformMs = 0;
    let accountId: AccountId | null = null;
    return {
        addPlatformTime: (ms) => {
            platformMs += ms;
        },
        setAccount: (id) => {
            accountId = id;
        },
        read: () => ({ platformMs, accountId }),
    };
}

// Handed from the entry to Start for each request (as `fetch(request, { context })`), and read
// back by the router (the nonce) and the platform gateway (the rest).
export type WebRequest = {
    readonly requestId: RequestId;
    readonly client: ClientInfo;
    readonly trace: RequestTrace;
    readonly throttle: Throttle;
};

export type StartRequestContext = {
    readonly nonce: string;
    readonly web: WebRequest;
};
