import { BearerToken } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, OauthCode, refusal, Unavailable } from "./shared.ts";

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

// The limits migration 0048 checks again in the table. `discordClaim` is what
// `waitlist.discord.claim` answered; null when the server has no Discord application.
export const ApplicationForm = z.strictObject({
    email: z.email().max(254),
    discordClaim: BearerToken.nullable(),
    experience: Text(1000),
    games: Text(300),
    // The username of a member who knows the applicant. Staff see it; it fast-tracks nothing, and
    // nothing here or in the answer says whether such a member exists.
    knownBy: Line(1, 64).nullable(),
    additional: Text(1000).nullable(),
});

export const waitlistContract = defineContract({
    // The OAuth code Discord returned: its user is joined to the guild and held for an hour under
    // `claim`, which the form then names.
    "waitlist.discord.claim": {
        session: "none",
        effect: "write",
        input: z.strictObject({ code: OauthCode }),
        output: z.object({ claim: BearerToken, username: z.string() }),
        error: z.discriminatedUnion("code", [Unavailable, refusal("DISCORD_LINK_FAILED")]),
    },
    // The same answer, after the same time, for a new address, one with an account and one with
    // an application waiting. DISCORD_LINK_REQUIRED says nothing about addresses: it is the claim
    // that is missing or expired.
    "waitlist.application.submit": {
        session: "none",
        effect: "write",
        input: ApplicationForm,
        output: Done,
        error: z.discriminatedUnion("code", [Unavailable, refusal("DISCORD_LINK_REQUIRED")]),
    },
});
