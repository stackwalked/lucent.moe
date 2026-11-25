import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchDiscordLink = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("discord.link.read", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const startDiscordLink = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("discord.link.start", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const removeDiscordLink = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("discord.link.remove", {});
    return reply.ok ? done(null) : refuse(reply.error);
});
