import { EpochMs, ProductId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { RuleFields, RuleId } from "../discord/rules.ts";
import {
    Done,
    refusal,
    SessionRefusal,
    SessionRefusals,
    StaffRefusals,
    Unavailable,
} from "./shared.ts";

// Linking starts here: a signed-in member gets a one-time code and gives it to /link in Discord.
// Editing the rules takes roles:manage: they map site standing onto Discord roles.

const Rule = z.object({ id: RuleId, createdAt: EpochMs, fields: RuleFields });

export const discordContract = defineContract({
    "discord.link.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ linkedAt: EpochMs.nullable() }),
        error: SessionRefusal,
    },
    // A new code replaces any earlier one; it works once, until `expiresAt`.
    "discord.link.start": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: z.object({ code: z.string(), expiresAt: EpochMs }),
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("ALREADY_LINKED"),
        ]),
    },
    // The synced roles leave at the connector's next tick.
    "discord.link.remove": {
        session: "member",
        effect: "write",
        input: z.strictObject({}),
        output: Done,
        error: SessionRefusal,
    },
    // Every rule, oldest first, with what a role rule may name.
    "admin.discord.rules.list": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({
            rules: z.array(Rule).readonly(),
            products: z.array(z.object({ id: ProductId, name: z.string() })).readonly(),
            roles: z.array(z.object({ id: RoleId, name: z.string() })).readonly(),
        }),
        error: z.discriminatedUnion("code", [...StaffRefusals]),
    },
    // The same rule again changes nothing and answers its id.
    "admin.discord.rules.add": {
        session: "member",
        effect: "write",
        input: z.strictObject({ fields: RuleFields }),
        output: z.object({ ruleId: RuleId }),
        error: z.discriminatedUnion("code", [
            ...StaffRefusals,
            refusal("UNKNOWN_PRODUCT"),
            refusal("NOT_FOUND"),
            // A queue feed (tickets, review) on a channel not marked staff.
            refusal("STAFF_CHANNEL_REQUIRED"),
        ]),
    },
    "admin.discord.rules.remove": {
        session: "member",
        effect: "write",
        input: z.strictObject({ ruleId: RuleId }),
        output: Done,
        error: z.discriminatedUnion("code", [...StaffRefusals, refusal("NOT_FOUND")]),
    },
});
