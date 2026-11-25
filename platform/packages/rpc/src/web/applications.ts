import { AccountId, BearerToken, EpochMs, ProductId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { Done, ReadRefusal, refusal, StaffRefusals } from "./shared.ts";

const ApplicationId = z.string().regex(/^[1-9][0-9]{0,18}$/);

const ApplicationState = z.enum(["pending", "approved", "declined"]);

// What the applicant typed comes back as plain text; web never renders it as markup.
const ApplicationSummary = z.object({
    applicationId: ApplicationId,
    email: z.string(),
    products: z.array(ProductId).readonly(),
    state: ApplicationState,
    createdAt: EpochMs,
    decidedAt: EpochMs.nullable(),
    knownBy: z.string().nullable(),
    // The address has an account now, so approving would be refused.
    emailHasAccount: z.boolean(),
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
            about: z.string(),
            discord: z.string().nullable(),
            // The account whose username matches `knownBy`, if one does.
            knownByMember: z.object({ accountId: AccountId, username: z.string() }).nullable(),
            decidedBy: z.object({ id: z.string(), username: z.string().nullable() }).nullable(),
            accountId: AccountId.nullable(),
        }),
        error: ReadRefusal,
    },
    // Creates the account and mails its setup link. Without a mail provider the link is in this
    // reply instead, for staff to hand over. No product access comes with it.
    "admin.applications.approve": {
        session: "member",
        effect: "write",
        input: z.strictObject({ applicationId: ApplicationId }),
        output: z.object({ accountId: AccountId, setupToken: BearerToken.nullable() }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("ALREADY_DECIDED"),
            refusal("EMAIL_TAKEN"),
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
