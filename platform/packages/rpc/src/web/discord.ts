import { EpochMs, ProductId, RoleId } from "@lucent/core/scalars";
import { z } from "zod";
import { defineContract } from "../contract.ts";
import { RuleFields, RuleId } from "../discord/rules.ts";
import {
    Done,
    OauthCode,
    refusal,
    SessionRefusal,
    SessionRefusals,
    StaffRefusals,
    Unavailable,
} from "./shared.ts";

// A signed-in member links Discord through OAuth. Editing the rules takes roles:manage: they map
// site standing onto Discord roles.

const Rule = z.object({ id: RuleId, createdAt: EpochMs, fields: RuleFields });

export const discordContract = defineContract({
    "discord.link.read": {
        session: "member",
        effect: "read",
        input: z.strictObject({}),
        output: z.object({ linkedAt: EpochMs.nullable() }),
        error: SessionRefusal,
    },
    // The OAuth code Discord returned to the site: the Discord user who authorized it is linked
    // to the signed-in account, and joined to the guild. DISCORD_LINK_FAILED also covers a server
    // with no Discord application configured.
    "discord.link.finish": {
        session: "member",
        effect: "write",
        input: z.strictObject({ code: OauthCode }),
        output: Done,
        error: z.discriminatedUnion("code", [
            Unavailable,
            ...SessionRefusals,
            refusal("ALREADY_LINKED"),
            refusal("DISCORD_LINK_FAILED"),
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
