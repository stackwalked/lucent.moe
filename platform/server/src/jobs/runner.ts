import { containBoundary } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import type { Logger } from "../core/log.ts";

// Work the server does on its own, on a timer. A run that returns a line logs it; a failure is
// logged and the next tick tries again.
export type Job = {
    readonly name: string;
    readonly everyMs: number;
    readonly run: () => Promise<Result<string | null, { readonly code: string }>>;
};

// Calls `tick` every `ms` until the returned function is called. Injected so tests drive time.
export type Every = (ms: number, tick: () => void) => () => void;

// Unref'd: a timer alone never keeps the process alive.
export const intervalEvery: Every = (ms, tick) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
};

export type RunningJobs = {
    // Stops the timers, then waits for runs in flight.
    readonly stop: () => Promise<void>;
};

// One instance does the work: a superseded one skips its ticks. A job still running when its next
// tick comes skips that tick rather than running twice at once.
export function startJobs(params: {
    readonly jobs: readonly Job[];
    readonly logger: Logger;
    readonly isSuperseded: () => boolean;
    readonly every?: Every;
}): RunningJobs {
    const every = params.every ?? intervalEvery;
    const inFlight = new Map<string, Promise<void>>();

    const tick = (job: Job): void => {
        if (params.isSuperseded() || inFlight.has(job.name)) return;
        const run = (async () => {
            const result = await containBoundary({
                run: job.run,
                onUnhandled: (detail) => err({ code: "UNHANDLED", detail }),
            });
            if (result.ok && result.value !== null) {
                params.logger.write("info", "job ran", {
                    origin: "jobs",
                    detail: `${job.name}: ${result.value}`,
                });
            }
            if (!result.ok) {
                params.logger.write("error", "job failed", {
                    origin: "jobs",
                    detail: `${job.name}: ${result.error.code}`,
                });
            }
        })().finally(() => inFlight.delete(job.name));
        inFlight.set(job.name, run);
    };

    const cancels = params.jobs.map((job) => every(job.everyMs, () => tick(job)));
    return {
        stop: async () => {
            for (const cancel of cancels) cancel();
            await Promise.all(inFlight.values());
        },
    };
}
