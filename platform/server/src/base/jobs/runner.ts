import type { Clock } from "@lucent/core/clock";
import { containBoundary } from "@lucent/core/contain";
import { err, type Result } from "@lucent/core/result";
import type { EpochMs } from "@lucent/core/scalars";
import type { Logger } from "../core/log.ts";

// Work the server does on its own, on a timer. A run that returns a line logs it; a failure is
// logged and the next tick tries again.
export type Job = {
    readonly name: string;
    readonly everyMs: number;
    readonly run: () => Promise<Result<string | null, { readonly code: string }>>;
};

// What the runner remembers of one finished run, for staff to read. A failure is its code alone:
// a detail (a database error's text, a thrown message) can carry a statement's values or an
// address, and a code that isn't shaped like one is not passed on either.
export type JobRun = {
    readonly name: string;
    readonly ranAt: EpochMs;
    readonly durationMs: number;
    readonly failure: string | null;
};

export type RecordJobRun = (run: JobRun) => Promise<Result<void, { readonly code: string }>>;

const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function toFailureReason(code: string): string {
    return FAILURE_CODE.test(code) ? code : "UNRECOGNIZED";
}

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
// tick comes skips that tick rather than running twice at once. A run counts as in flight until
// it is recorded, so records of one job arrive in the order its runs did.
export function startJobs(params: {
    readonly jobs: readonly Job[];
    readonly logger: Logger;
    readonly isSuperseded: () => boolean;
    readonly clock: Clock;
    readonly record: RecordJobRun;
    readonly every?: Every;
}): RunningJobs {
    const every = params.every ?? intervalEvery;
    const inFlight = new Map<string, Promise<void>>();

    const tick = (job: Job): void => {
        if (params.isSuperseded() || inFlight.has(job.name)) return;
        const run = (async () => {
            const ranAt = params.clock.now();
            const result = await containBoundary({
                run: job.run,
                onUnhandled: (detail) => err({ code: "UNHANDLED", detail }),
            });
            const durationMs = Math.max(0, params.clock.now() - ranAt);
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
            const recorded = await containBoundary({
                run: () =>
                    params.record({
                        name: job.name,
                        ranAt,
                        durationMs,
                        failure: result.ok ? null : toFailureReason(result.error.code),
                    }),
                onUnhandled: () => err({ code: "UNHANDLED" }),
            });
            if (!recorded.ok) {
                params.logger.write("warn", "job run not recorded", {
                    origin: "jobs",
                    detail: `${job.name}: ${recorded.error.code}`,
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
