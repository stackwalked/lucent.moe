import { err, ok, type Result } from "@lucent/core/result";

// Streams are open connections held in memory, so they are bounded: per account, so one account
// cannot hold the process's connections, and overall, so all of them together cannot.
export const MAX_STREAMS_PER_ACCOUNT = 4;
export const MAX_STREAMS = 2_000;

export type StreamRefusal = { readonly code: "SERVICE_UNAVAILABLE" };

export function decideStreamAdmission(params: {
    readonly accountStreams: number;
    readonly totalStreams: number;
}): Result<null, StreamRefusal> {
    if (params.accountStreams >= MAX_STREAMS_PER_ACCOUNT) {
        return err({ code: "SERVICE_UNAVAILABLE" });
    }
    if (params.totalStreams >= MAX_STREAMS) return err({ code: "SERVICE_UNAVAILABLE" });
    return ok(null);
}
