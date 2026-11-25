import type { Handlers } from "@lucent/rpc/mount";
import type { discordContract } from "@lucent/rpc/web/discord";
import { readDiscordLink, removeDiscordLinkBySite, startDiscordLink } from "../../discord/links.ts";
import { addRule, listRulesAsStaff, removeRule } from "../../discord/rules.ts";
import { asStaff, done, served, type WebRpcContext } from "./web-shared.ts";

export const discordHandlers = {
    "discord.link.read": async (ctx, _input, { session }) =>
        served(await readDiscordLink(ctx.auth.db, session)),
    "discord.link.start": async (ctx, _input, { session }) =>
        served(await startDiscordLink(ctx.auth.db, { token: session, rng: ctx.auth.rng })),
    "discord.link.remove": async (ctx, _input, { session, client }) =>
        served(done(await removeDiscordLinkBySite(ctx.auth.db, { token: session, client }))),
    "admin.discord.rules.list": (ctx, _input, call) =>
        asStaff(ctx, call, (caller) =>
            listRulesAsStaff(ctx.auth.db, { caller, catalog: ctx.catalog }),
        ),
    "admin.discord.rules.add": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            addRule(ctx.auth.db, { caller, catalog: ctx.catalog, fields: input.fields }),
        ),
    "admin.discord.rules.remove": (ctx, input, call) =>
        asStaff(ctx, call, async (caller) =>
            done(await removeRule(ctx.auth.db, { caller, ruleId: input.ruleId })),
        ),
} satisfies Handlers<WebRpcContext, typeof discordContract>;
