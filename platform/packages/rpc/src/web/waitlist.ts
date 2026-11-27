import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, Unavailable } from "./shared.ts";

// What an applicant types. Control characters are refused (the free text keeps line breaks and
// tabs): staff read these as plain text, never as markup.
const Line = (min: number, max: number) =>
    z
        .string()
        .trim()
        .min(min)
        .max(max)
        .regex(/^[^\p{Cc}]+$/u);

const Text = (max: number) =>
    z
        .string()
        .trim()
        .min(1)
        .max(max)
        .regex(/^(?:[^\p{Cc}]|[\n\t])+$/u);

// The limits migration 0048 checks again in the table.
export const ApplicationForm = z.strictObject({
    email: z.email().max(254),
    // A plain string for staff to read; it links nothing and is never verified. Two to 32
    // characters, as Discord allows.
    discord: Line(2, 32),
    experience: Text(1000),
    games: Text(300),
    // The username of a member who knows the applicant. Staff see it; it fast-tracks nothing, and
    // nothing here or in the answer says whether such a member exists.
    knownBy: Line(1, 64).nullable(),
    additional: Text(1000).nullable(),
});

export const waitlistContract = defineContract({
    // The same answer, after the same time, for a new address, one with an account and one with
    // an application waiting.
    "waitlist.application.submit": {
        session: "none",
        effect: "write",
        input: ApplicationForm,
        output: Done,
        error: z.discriminatedUnion("code", [Unavailable]),
    },
});
