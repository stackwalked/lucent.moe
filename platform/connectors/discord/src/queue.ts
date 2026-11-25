import { containBoundary } from "@lucent/core/contain";

// Every change the connector makes in the guild runs here, one job at a time, so a reconcile and
// a member's tick never interleave their reads and writes of one member's roles. A job with a
// key already waiting is not queued twice: the waiting one will see the newer state anyway.
export type SerialQueue = {
    readonly push: (key: string, job: () => Promise<void>) => Promise<void>;
    // Resolves once everything queued so far has run.
    readonly idle: () => Promise<void>;
};

export function createSerialQueue(onFailure: (key: string, detail: string) => void): SerialQueue {
    let tail: Promise<void> = Promise.resolve();
    const waiting = new Map<string, Promise<void>>();
    return {
        push: (key, job) => {
            const queued = waiting.get(key);
            if (queued !== undefined) return queued;
            const run = tail.then(async () => {
                waiting.delete(key);
                await containBoundary({
                    run: async () => {
                        await job();
                        return null;
                    },
                    onUnhandled: (detail) => {
                        onFailure(key, detail);
                        return null;
                    },
                });
            });
            waiting.set(key, run);
            tail = run;
            return run;
        },
        idle: () => tail,
    };
}
