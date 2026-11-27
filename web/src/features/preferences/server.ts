import { SetPreference } from "@lucent/rpc/web/preferences";
import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchPreferences = createServerFn({ method: "GET" }).handler(async () => {
    const preferences = await readPlatform("preferences.channels.list", {});
    if (!preferences.ok) return refuse(preferences.error);
    const discord = await readPlatform("discord.link.read", {});
    if (!discord.ok) return refuse(discord.error);
    return done({
        securityDiscord: preferences.value.security.discord,
        discordLinked: discord.value.linkedAt !== null,
    });
});

export const savePreference = createServerFn({ method: "POST" })
    .validator((data: unknown) => SetPreference.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("preferences.channels.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
