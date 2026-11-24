import { expect, test } from "bun:test";
import type { Clock } from "@lucent/core/clock";
import { raiseInvariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { EpochMs } from "@lucent/core/scalars";
import type { Logger } from "../src/core/log.ts";
import {
    type Every,
    type Job,
    type JobRun,
    type RecordJobRun,
    startJobs,
} from "../src/jobs/runner.ts";

// A timer the test fires by hand.
function manualTimer(): Every & { readonly fire: () => void } {
    const ticks = new Set<() => void>();
    const every: Every = (_ms, tick) => {
        ticks.add(tick);
        return () => ticks.delete(tick);
    };
    return Object.assign(every, {
        fire: () => {
            for (const tick of ticks) tick();
        },
    });
}

function recordingLogger(): Logger & { readonly lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        write: (level, msg, fields) => lines.push(`${level} ${msg} ${fields?.detail}`),
    };
}

// A clock a job moves forward while it runs.
function steppingClock(start: number): Clock & { readonly advance: (ms: number) => void } {
    let now = start;
    return {
        now: () => EpochMs.parse(now),
        advance: (ms) => {
            now += ms;
        },
    };
}

function recorder(): { readonly runs: JobRun[]; readonly record: RecordJobRun } {
    const runs: JobRun[] = [];
    return {
        runs,
        record: (run) => {
            runs.push(run);
            return Promise.resolve(ok(undefined));
        },
    };
}

test("a job still running when its next tick comes is not started again", async () => {
    const timer = manualTimer();
    let started = 0;
    let finish: () => void = () => {};
    const job: Job = {
        name: "slow",
        everyMs: 1,
        run: () => {
            started += 1;
            return new Promise((resolve) => {
                finish = () => resolve(ok(null));
            });
        },
    };
    const jobs = startJobs({
        jobs: [job],
        logger: recordingLogger(),
        isSuperseded: () => false,
        clock: steppingClock(0),
        record: recorder().record,
        every: timer,
    });
    timer.fire();
    timer.fire();
    expect(started).toBe(1);
    finish();
    await Bun.sleep(0);
    timer.fire();
    expect(started).toBe(2);
    finish();
    await jobs.stop();
});

test("a superseded instance runs nothing, and a failing job is logged and tried again", async () => {
    const timer = manualTimer();
    const logger = recordingLogger();
    let superseded = true;
    let runs = 0;
    const jobs = startJobs({
        jobs: [
            {
                name: "flaky",
                everyMs: 1,
                run: () => {
                    runs += 1;
                    return Promise.resolve(err({ code: "DB_UNAVAILABLE" }));
                },
            },
        ],
        logger,
        isSuperseded: () => superseded,
        clock: steppingClock(0),
        record: recorder().record,
        every: timer,
    });
    timer.fire();
    expect(runs).toBe(0);
    superseded = false;
    timer.fire();
    await Bun.sleep(0);
    timer.fire();
    await jobs.stop();
    expect(runs).toBe(2);
    expect(logger.lines).toEqual([
        "error job failed flaky: DB_UNAVAILABLE",
        "error job failed flaky: DB_UNAVAILABLE",
    ]);
});

test("every run is recorded with its start and duration, and a failure only as its code", async () => {
    const timer = manualTimer();
    const clock = steppingClock(1_000);
    const { runs, record } = recorder();
    const secret = "alice@lucent.test password=hunter2";
    const jobs = startJobs({
        jobs: [
            {
                name: "fine",
                everyMs: 1,
                run: () => {
                    clock.advance(25);
                    return Promise.resolve(ok(null));
                },
            },
            {
                name: "refused",
                everyMs: 1,
                run: () =>
                    Promise.resolve(
                        err({ code: "DB_UNAVAILABLE", detail: `duplicate key (${secret})` }),
                    ),
            },
            {
                name: "throws",
                everyMs: 1,
                run: () => Promise.resolve(raiseInvariant(`while reading ${secret}`)),
            },
            {
                name: "odd code",
                everyMs: 1,
                run: () => Promise.resolve(err({ code: `failed for ${secret}` })),
            },
        ],
        logger: recordingLogger(),
        isSuperseded: () => false,
        clock,
        record,
        every: timer,
    });
    timer.fire();
    await jobs.stop();
    expect(runs).toHaveLength(4);
    expect(runs).toEqual(
        expect.arrayContaining([
            { name: "fine", ranAt: EpochMs.parse(1_000), durationMs: 25, failure: null },
            {
                name: "refused",
                ranAt: EpochMs.parse(1_025),
                durationMs: 0,
                failure: "DB_UNAVAILABLE",
            },
            { name: "throws", ranAt: EpochMs.parse(1_025), durationMs: 0, failure: "UNHANDLED" },
            {
                name: "odd code",
                ranAt: EpochMs.parse(1_025),
                durationMs: 0,
                failure: "UNRECOGNIZED",
            },
        ]),
    );
    expect(JSON.stringify(runs)).not.toContain("alice");
});

test("a run that can't be recorded is logged and the job keeps its schedule", async () => {
    const timer = manualTimer();
    const logger = recordingLogger();
    let runs = 0;
    const jobs = startJobs({
        jobs: [
            {
                name: "steady",
                everyMs: 1,
                run: () => {
                    runs += 1;
                    return Promise.resolve(ok(null));
                },
            },
        ],
        logger,
        isSuperseded: () => false,
        clock: steppingClock(0),
        record: () => Promise.resolve(err({ code: "DB_UNAVAILABLE" })),
        every: timer,
    });
    timer.fire();
    await Bun.sleep(0);
    timer.fire();
    await jobs.stop();
    expect(runs).toBe(2);
    expect(logger.lines).toEqual([
        "warn job run not recorded steady: DB_UNAVAILABLE",
        "warn job run not recorded steady: DB_UNAVAILABLE",
    ]);
});
