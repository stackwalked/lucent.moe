import { expect, test } from "bun:test";
import { err, ok } from "@lucent/core/result";
import type { Logger } from "../src/core/log.ts";
import { type Every, type Job, startJobs } from "../src/jobs/runner.ts";

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
