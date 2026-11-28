import { err } from "@lucent/core/result";
import type { Handlers } from "@lucent/rpc/mount";
import type { discordContract } from "@lucent/rpc/web/discord";
import {
    linkDiscordAccount,
    readDiscordLink,
    removeDiscordLinkBySite,
} from "../../discord/links.ts";
import { addRule, listRulesAsStaff, removeRule } from "../../discord/rules.ts";
import { asStaff, done, served, type WebRpcContext } from "./web-shared.ts";

export const discordHandlers = {
    "discord.link.read": async (ctx, _input, { session }) =>
        served(await readDiscordLink(ctx.auth.db, session)),
    "discord.link.finish": async (ctx, input, { session, client }) => {
        // Before the code is spent: an account that is linked would refuse the link after the join.
        const standing = await readDiscordLink(ctx.auth.db, session);
        if (!standing.ok) return served(standing);
        if (standing.value.linkedAt !== null) return err({ code: "ALREADY_LINKED" });
        if (ctx.discordOauth == null) return err({ code: "DISCORD_LINK_FAILED" });
        const identity = await ctx.discordOauth.identify(input.code);
        if (!identity.ok) return identity;
        return served(
            done(
                await linkDiscordAccount(ctx.auth.db, {
                    token: session,
                    identity: identity.value,
                    client,
                }),
            ),
        );
    },
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
