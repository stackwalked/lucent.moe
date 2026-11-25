import { EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, refusal, SessionRefusals, Unavailable } from "./shared.ts";

// A member deleting their own account: asking starts a seven-day wait, the member keeps the
// account by signing in and cancelling, and when the wait ends the account is gone for good. A
// suspended account deletes from its appeal session, through the same three as appeals.deletion.*.

export const DeletionStatus = z.discriminatedUnion("state", [
    z.object({ state: z.literal("none") }),
    z.object({ state: z.literal("pending"), requestedAt: EpochMs, dueAt: EpochMs }),
]);

const Status = {
    effect: "read",
    input: z.strictObject({}),
    output: DeletionStatus,
    error: z.discriminatedUnion("code", [Unavailable, refusal("SESSION_INVALID")]),
} as const;

// Needs a factor proven within the last five minutes (REAUTH_REQUIRED). Asking again while one
// waits answers with the date already set.
const Request = {
    effect: "write",
    input: z.strictObject({}),
    output: z.object({ dueAt: EpochMs }),
    error: z.discriminatedUnion("code", [
        Unavailable,
        ...SessionRefusals,
        // Staff and root are demoted before they can delete themselves.
        refusal("STAFF_CANNOT_DELETE"),
    ]),
} as const;

const Cancel = {
    effect: "write",
    input: z.strictObject({}),
    output: Done,
    error: z.discriminatedUnion("code", [Unavailable, refusal("SESSION_INVALID")]),
} as const;

export const deletionContract = defineContract({
    "deletion.request.read": { session: "member", ...Status },
    "deletion.request.create": { session: "member", ...Request },
    "deletion.request.cancel": { session: "member", ...Cancel },
    "appeals.deletion.read": { session: "appeal", ...Status },
    "appeals.deletion.request": { session: "appeal", ...Request },
    "appeals.deletion.cancel": { session: "appeal", ...Cancel },
});
