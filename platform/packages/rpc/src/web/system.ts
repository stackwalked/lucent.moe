import { EpochMs, ServiceEpoch } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { SealNumber, StaffRefusals } from "./shared.ts";

const Count = z.number().int().nonnegative();

const Job = z.object({
    name: z.string(),
    ranAt: EpochMs,
    durationMs: Count,
    // Whether the last run failed. A failure is its refusal code, never a detail.
    failed: z.boolean(),
    lastFailure: z.object({ at: EpochMs, reason: z.string() }).nullable(),
});

export const systemContract = defineContract({
    // The service as the server already knows it: the epoch serving, the schema the database has
    // and the one this build carries, each job's last run, PostgreSQL's connections per pool, the
    // mail waiting to go out and the artifact directory's size ("none" without the loaders'
    // listener).
    "admin.system.status.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            epoch: ServiceEpoch,
            schema: z.object({ database: Count, build: Count }),
            jobs: z.array(Job).readonly(),
            connections: z
                .array(
                    z.object({
                        application: z.string(),
                        total: Count,
                        active: Count,
                        idleInTransaction: Count,
                    }),
                )
                .readonly(),
            mail: z.object({ pending: Count, sending: Count, oldestDueAt: EpochMs.nullable() }),
            artifacts: z.discriminatedUnion("state", [
                z.object({ state: z.literal("none") }),
                z.object({ state: z.literal("unreadable") }),
                z.object({ state: z.literal("read"), files: Count, bytes: Count }),
            ]),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // Twelve ISO weeks (UTC) ending with the one holding `endingWith`, or now: distinct accounts
    // per product per week with a session active in it, and the sessions started per release.
    "admin.system.usage.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({ endingWith: EpochMs.nullable() }),
        output: z.object({
            from: EpochMs,
            until: EpochMs,
            weeks: z
                .array(
                    z.object({
                        weekStart: EpochMs,
                        isoYear: Count,
                        isoWeek: Count,
                        productId: z.string(),
                        accounts: Count,
                    }),
                )
                .readonly(),
            releases: z
                .array(
                    z.object({
                        productId: z.string(),
                        channel: z.string(),
                        number: SealNumber,
                        sessions: Count,
                        accounts: Count,
                    }),
                )
                .readonly(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
});
