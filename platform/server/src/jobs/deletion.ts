import { ok } from "@lucent/core/result";
import type { AccountId } from "@lucent/core/scalars";
import type { Logger } from "../core/log.ts";
import type { Db } from "../db/pool.ts";
import type { EmailHasher } from "../deletion/email-hash.ts";
import { completeDeletion, listDueDeletions } from "../deletion/strip.ts";
import type { Job } from "./runner.ts";

// Each run takes at most this many: one transaction each, so a long backlog spreads over runs.
const BATCH = 50;

// Completes the deletions whose grace period has ended. One held by a role granted meanwhile is
// never listed, only counted, so it can't fill a batch. One that fails is skipped for this run and
// named in one warning, and the rest go ahead: a single bad account must not stop every deletion
// behind it. One cancelled or completed between the listing and its lock is skipped quietly.
export function deletionJob(deps: {
    readonly db: Db;
    readonly emailHasher: EmailHasher;
    readonly logger: Logger;
}): Job {
    return {
        name: "deletion",
        everyMs: 10 * 60 * 1_000,
        run: async () => {
            const listed = await listDueDeletions(deps.db, BATCH);
            if (!listed.ok) return listed;
            let completed = 0;
            const failed: string[] = [];
            for (const accountId of listed.value.due) {
                const done = await completeDeletion(deps, accountId);
                if (done.ok) {
                    completed += 1;
                    continue;
                }
                if (!isSkippable(done.error.code)) failed.push(failure(accountId, done.error.code));
            }
            if (failed.length > 0) {
                deps.logger.write("warn", "deletions failed", {
                    origin: "jobs",
                    detail: failed.join(", "),
                });
            }
            const { held } = listed.value;
            if (completed === 0 && held === 0 && failed.length === 0) return ok(null);
            return ok(
                `completed ${completed} deletions, ${failed.length} failed, ${held} held by a role`,
            );
        },
    };
}

function isSkippable(code: string): boolean {
    return [
        "NOT_DUE",
        "NOT_PENDING",
        "ACCOUNT_DELETED",
        "NOT_FOUND",
        "STAFF_CANNOT_DELETE",
    ].includes(code);
}

// The account and the refusal code only: a failure's detail can carry a statement's values.
function failure(accountId: AccountId, code: string): string {
    return `${accountId} ${code}`;
}
