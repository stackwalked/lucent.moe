import { ok } from "@lucent/core/result";
import type { Db } from "../db/pool.ts";
import type { EmailHasher } from "../deletion/email-hash.ts";
import { completeDeletion, listDueDeletions } from "../deletion/strip.ts";
import type { Job } from "./runner.ts";

// Each run takes at most this many: one transaction each, so a long backlog spreads over runs.
const BATCH = 50;

// Completes the deletions whose grace period has ended. One held by a role granted meanwhile
// (STAFF_CANNOT_DELETE) stays pending and is counted, so the system page says it waits; one
// cancelled or completed between the listing and its lock is skipped.
export function deletionJob(deps: { readonly db: Db; readonly emailHasher: EmailHasher }): Job {
    return {
        name: "deletion",
        everyMs: 10 * 60 * 1_000,
        run: async () => {
            const due = await listDueDeletions(deps.db, BATCH);
            if (!due.ok) return due;
            let completed = 0;
            let held = 0;
            for (const accountId of due.value) {
                const done = await completeDeletion(deps, accountId);
                if (done.ok) {
                    completed += 1;
                    continue;
                }
                switch (done.error.code) {
                    case "STAFF_CANNOT_DELETE":
                        held += 1;
                        continue;
                    case "NOT_DUE":
                    case "NOT_PENDING":
                    case "ACCOUNT_DELETED":
                    case "NOT_FOUND":
                        continue;
                    default:
                        return done;
                }
            }
            if (completed === 0 && held === 0) return ok(null);
            return ok(`completed ${completed} deletions, ${held} held by a role`);
        },
    };
}
