import { RuleFields, RuleId } from "@lucent/rpc/discord/rules";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listDiscordRules = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.discord.rules.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const addDiscordRule = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ fields: RuleFields }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.discord.rules.add", data);
        return reply.ok ? done(reply.value.ruleId) : refuse(reply.error);
    });

export const removeDiscordRule = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ ruleId: RuleId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.discord.rules.remove", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
