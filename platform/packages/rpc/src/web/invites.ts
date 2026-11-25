import { AccountId, BearerToken, EpochMs } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { AccountStatus } from "./authority.ts";
import { Done, ReadRefusal, refusal, StaffRefusals, Unavailable } from "./shared.ts";

const InviteId = z.string().regex(/^[1-9][0-9]{0,18}$/);

const Count = z.number().int().nonnegative();

// How many of an account's invitees were suspended: `ever` counts any suspension, which a
// reinstatement does not erase; `now` those suspended at the moment.
const Strikes = z.object({ ever: Count, now: Count });

const MemberRefusals = [Unavailable, refusal("SESSION_INVALID")] as const;

// `granted` is what staff let the member issue in all; `spent` counts the invites used or still
// open. An invite revoked or left to expire unused is not spent.
const Allowance = { granted: Count, spent: Count };

export const invitesContract = defineContract({
    "invites.mine.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            ...Allowance,
            invites: z
                .array(
                    z.object({
                        inviteId: InviteId,
                        state: z.enum(["unused", "used", "revoked", "expired"]),
                        createdAt: EpochMs,
                        expiresAt: EpochMs,
                        invitee: z.object({ username: z.string().nullable() }).nullable(),
                    }),
                )
                .readonly(),
        }),
        error: z.discriminatedUnion("code", [...MemberRefusals]),
    },
    // Single use, for seven days. The token is in this reply only; the link is `/invite#<token>`.
    "invites.mine.create": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: z.object({ inviteId: InviteId, token: BearerToken, expiresAt: EpochMs }),
        error: z.discriminatedUnion("code", [...MemberRefusals, refusal("NO_ALLOWANCE")]),
    },
    // An unused invite stops working and returns to the allowance. One already revoked or expired
    // is left as it is.
    "invites.mine.revoke": {
        session: "member",
        effect: "write",
        input: z.strictObject({ inviteId: InviteId }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...MemberRefusals,
            refusal("NOT_FOUND"),
            refusal("INVITE_USED"),
        ]),
    },
    // Creates an account for the address and mails its setup link. The answer is the same whether
    // or not the address already has an account. INVITE_INVALID: unknown, used, revoked, expired,
    // or its inviter is suspended.
    "invites.link.redeem": {
        session: "none",
        effect: "write",
        input: z.strictObject({ token: BearerToken, email: z.email().max(254) }),
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            refusal("INVITE_INVALID"),
            refusal("MAIL_DISABLED"),
        ]),
    },

    "admin.invites.account": {
        session: "member",
        effect: "read",
        input: z.strictObject({ accountId: AccountId }),
        output: z.object({
            ...Allowance,
            invitedBy: z
                .object({ accountId: AccountId, username: z.string().nullable() })
                .nullable(),
            invitees: Count,
            strikes: Strikes,
        }),
        error: ReadRefusal,
    },
    // Every account that invited or was invited, oldest first, with who invited it; at most a
    // fixed number, `truncated` saying there were more.
    "admin.invites.tree": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            members: z
                .array(
                    z.object({
                        accountId: AccountId,
                        username: z.string().nullable(),
                        status: AccountStatus,
                        invitedBy: AccountId.nullable(),
                        invitees: Count,
                        strikes: Strikes,
                    }),
                )
                .readonly(),
            truncated: z.boolean(),
        }),
        error: ReadRefusal,
    },
    // Sets what the account may issue in all; never below what it has spent.
    "admin.invites.grant": {
        session: "member",
        effect: "write",
        input: z.strictObject({ accountId: AccountId, granted: z.number().int().min(0).max(1000) }),
        output: Done,
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("NOT_FOUND"),
            refusal("BELOW_SPENT"),
        ]),
    },
});
