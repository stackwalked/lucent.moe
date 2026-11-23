import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { refusal, StaffRefusals } from "./shared.ts";

const ReviewItemId = z.string().regex(/^[1-9][0-9]{0,18}$/);

const ReviewOutcome = z.enum(["no_action", "actioned"]);

// Kinds stay open: rows outlive the code that scored them.
const Contribution = z.object({
    kind: z.string(),
    sessions: z.number().int().nonnegative(),
    lastAt: EpochMs,
    weight: z.number(),
});

const ReviewItem = z.object({
    id: ReviewItemId,
    account: z.object({ id: AccountId, username: z.string().nullable() }),
    risk: z.number().int().min(0).max(100),
    urgency: z.number().int().min(0).max(100),
    signals: z.array(Contribution).readonly(),
    openedAt: EpochMs,
    scoredAt: EpochMs,
    decision: z
        .object({
            outcome: ReviewOutcome,
            at: EpochMs,
            by: z.object({ id: z.string(), username: z.string().nullable() }),
            note: z.string().nullable(),
        })
        .nullable(),
});

export const reviewContract = defineContract({
    // The risk review queue: open items most urgent first, or the latest decided ones.
    "admin.review.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ state: z.enum(["open", "decided"]) }),
        output: z.object({ items: z.array(ReviewItem).readonly() }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // Closes an open item with its outcome. What staff did about the account is its own action.
    "admin.review.decide": {
        session: "member",
        effect: "write",
        input: z.strictObject({
            itemId: ReviewItemId,
            outcome: ReviewOutcome,
            note: z.string().trim().max(500).nullable(),
        }),
        output: z.object({}),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("ALREADY_DECIDED"),
        ]),
    },
});
