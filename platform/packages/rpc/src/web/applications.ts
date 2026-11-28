import { AccountId, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Snowflake } from "../discord/rules.ts";
import { Done, ReadRefusal, refusal, StaffRefusals } from "./shared.ts";

const ApplicationId = z.string().regex(/^[1-9][0-9]{0,18}$/);

const ApplicationState = z.enum(["pending", "approved", "declined"]);

// What the applicant typed comes back as plain text; web never renders it as markup.
const ApplicationSummary = z.object({
    applicationId: ApplicationId,
    email: z.string(),
    games: z.string(),
    state: ApplicationState,
    createdAt: EpochMs,
    decidedAt: EpochMs.nullable(),
    knownBy: z.string().nullable(),
    // The address has an account now, so approving would be refused.
    emailHasAccount: z.boolean(),
    // The address was a suspended account's, deleted since: that person is applying again.
    // Optional for one deploy.
    returningAccountId: AccountId.nullable().optional(),
});

export const applicationsContract = defineContract({
    // Pending ones oldest first, decided ones newest first, at most a fixed number; `truncated`
    // says there were more.
    "admin.applications.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({ state: ApplicationState }),
        output: z.object({ items: z.array(ApplicationSummary).readonly(), truncated: z.boolean() }),
        error: ReadRefusal,
    },
    "admin.applications.get": {
        session: "member",
        effect: "read",
        input: z.strictObject({ applicationId: ApplicationId }),
        output: ApplicationSummary.extend({
            // The handle: as typed when `discordUserId` is null, else the one Discord verified.
            discord: z.string(),
            discordUserId: Snowflake.nullable(),
            // The account that Discord user is linked to now, if any.
            discordAccount: z
                .object({ accountId: AccountId, username: z.string().nullable() })
                .nullable(),
            experience: z.string(),
            additional: z.string().nullable(),
            // The account whose username matches `knownBy`, if one does.
            knownByMember: z.object({ accountId: AccountId, username: z.string() }).nullable(),
            decidedBy: z.object({ id: z.string(), username: z.string().nullable() }).nullable(),
            accountId: AccountId.nullable(),
        }),
        error: ReadRefusal,
    },
    // Creates the account and mails its setup link; no product access comes with it. Without a mail
    // provider nothing is approved (MAIL_DISABLED): staff can create the account by hand.
    "admin.applications.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ applicationId: ApplicationId }),
        output: z.object({ accountId: AccountId }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("ALREADY_DECIDED"),
            refusal("EMAIL_TAKEN"),
            refusal("MAIL_DISABLED"),
        ]),
    },
    "admin.applications.decline": {
        session: "member",
        effect: "write",
        input: z.strictObject({ applicationId: ApplicationId }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("ALREADY_DECIDED"),
        ]),
    },
});
