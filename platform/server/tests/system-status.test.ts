import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "@lucent/core/contain";
import { err, ok } from "@lucent/core/result";
import { createSeededRng } from "@lucent/core/rng";
import { EpochMs } from "@lucent/core/scalars";
import type { Logger } from "../src/core/log.ts";
import { execute, sql } from "../src/db/pool.ts";
import { type Every, startJobs } from "../src/jobs/runner.ts";
import { recordJobRuns } from "../src/system/jobs.ts";
import { readSystemStatus } from "../src/system/status.ts";
import { seedAccount, seedRoot, steppedUp } from "./authority-fixtures.ts";
import { sharedTestCluster } from "./harness/pg-test.ts";

const SILENT: Logger = { write: () => {} };

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

describe("the system page", () => {
    test("a failing job shows as failed with its code and no secret, and keeps it after a success", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1220);
            const root = await seedRoot(nativeDb, rng);
            let now = Date.parse("2026-11-24T10:00:00.000Z");
            let failing = true;
            const secret = "alice@lucent.test token=lsess_0123456789";
            // One tick of the job under a fresh runner, as a restarted instance would run it.
            const runOnce = async () => {
                const timer = manualTimer();
                const jobs = startJobs({
                    jobs: [
                        {
                            name: "mail delivery",
                            everyMs: 1,
                            run: () => {
                                now += 40;
                                return Promise.resolve(
                                    failing
                                        ? err({
                                              code: "DB_UNAVAILABLE",
                                              detail: `sending to ${secret}`,
                                          })
                                        : ok(null),
                                );
                            },
                        },
                    ],
                    logger: SILENT,
                    isSuperseded: () => false,
                    clock: { now: () => EpochMs.parse(now) },
                    record: recordJobRuns(nativeDb),
                    every: timer,
                });
                timer.fire();
                await jobs.stop();
            };
            await runOnce();
            const caller = await steppedUp(nativeDb, root);
            const failed = await readSystemStatus(nativeDb, { caller, artifactDir: null });
            invariant(failed.ok, `status readable: ${JSON.stringify(failed)}`);
            const firstRun = EpochMs.parse(Date.parse("2026-11-24T10:00:00.000Z"));
            expect(failed.value.jobs).toEqual([
                {
                    name: "mail delivery",
                    ranAt: firstRun,
                    durationMs: 40,
                    failed: true,
                    lastFailure: { at: firstRun, reason: "DB_UNAVAILABLE" },
                },
            ]);
            expect(JSON.stringify(failed.value)).not.toContain("alice");
            expect(JSON.stringify(failed.value)).not.toContain("lsess_");

            failing = false;
            await runOnce();
            const recovered = await readSystemStatus(nativeDb, { caller, artifactDir: null });
            invariant(recovered.ok, "status readable");
            expect(recovered.value.jobs).toEqual([
                {
                    name: "mail delivery",
                    ranAt: EpochMs.parse(firstRun + 40),
                    durationMs: 40,
                    failed: false,
                    lastFailure: { at: firstRun, reason: "DB_UNAVAILABLE" },
                },
            ]);
        });
    });

    test("an older run recorded late never replaces a newer one", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const record = recordJobRuns(nativeDb);
            const run = (ranAt: number, failure: string | null) =>
                record({ name: "retention", ranAt: EpochMs.parse(ranAt), durationMs: 5, failure });
            expect(await run(2_000, null)).toEqual(ok(undefined));
            expect(await run(1_000, "DB_UNAVAILABLE")).toEqual(ok(undefined));
            const rng = createSeededRng(1221);
            const root = await seedRoot(nativeDb, rng);
            const status = await readSystemStatus(nativeDb, {
                caller: await steppedUp(nativeDb, root),
                artifactDir: null,
            });
            invariant(status.ok, "status readable");
            expect(status.value.jobs).toEqual([
                {
                    name: "retention",
                    ranAt: EpochMs.parse(2_000),
                    durationMs: 5,
                    failed: false,
                    lastFailure: null,
                },
            ]);
        });
    });

    test("epoch, schema, connections, mail backlog and artifact size are what the server holds", async () => {
        const cluster = await sharedTestCluster();
        await cluster.withTestDb(async ({ nativeDb }) => {
            const rng = createSeededRng(1222);
            const root = await seedRoot(nativeDb, rng);
            const member = await seedAccount(nativeDb, rng, "member@lucent.test");
            await execute(
                nativeDb,
                sql`insert into mail_outbox (recipient, subject, body, due_at)
                    values ('a@lucent.test', 's', 'b', '2026-11-24T09:00:00Z'),
                           ('b@lucent.test', 's', 'b', '2026-11-24T09:30:00Z')`,
            );
            const dir = await mkdtemp(join(tmpdir(), "lucent-artifacts-"));
            await writeFile(join(dir, "a".repeat(64)), new Uint8Array(1_000));
            await writeFile(join(dir, "b".repeat(64)), new Uint8Array(24));
            const caller = await steppedUp(nativeDb, root);

            const status = await readSystemStatus(nativeDb, { caller, artifactDir: dir });
            invariant(status.ok, `status readable: ${JSON.stringify(status)}`);
            expect(Number(status.value.epoch)).toBe(1);
            expect(status.value.schema.database).toBe(status.value.schema.build);
            expect(status.value.schema.build).toBeGreaterThanOrEqual(20);
            expect(status.value.mail).toEqual({
                pending: 2,
                sending: 0,
                oldestDueAt: EpochMs.parse(Date.parse("2026-11-24T09:00:00.000Z")),
            });
            expect(status.value.artifacts).toEqual({ state: "read", files: 2, bytes: 1_024 });
            const reading = status.value.connections.find(
                (row) => row.application === "test-native",
            );
            expect(reading?.active).toBeGreaterThanOrEqual(1);
            expect(JSON.stringify(status.value)).not.toContain("a@lucent.test");

            const notADirectory = join(dir, "a".repeat(64));
            const blocked = await readSystemStatus(nativeDb, {
                caller,
                artifactDir: notADirectory,
            });
            expect(blocked.ok && blocked.value.artifacts).toEqual({ state: "unreadable" });

            await rm(dir, { recursive: true });
            const gone = await readSystemStatus(nativeDb, { caller, artifactDir: dir });
            expect(gone.ok && gone.value.artifacts).toEqual({ state: "read", files: 0, bytes: 0 });
            expect(
                await readSystemStatus(nativeDb, {
                    caller: await steppedUp(nativeDb, member),
                    artifactDir: null,
                }),
            ).toEqual(err({ code: "FORBIDDEN" }));
        });
    });
});
