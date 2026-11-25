import { SetPreference, SetSubscription } from "@lucent/rpc/web/preferences";
import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchPreferences = createServerFn({ method: "GET" }).handler(async () => {
    const preferences = await readPlatform("preferences.channels.list", {});
    if (!preferences.ok) return refuse(preferences.error);
    const listed = await readPlatform("products.list", {});
    if (!listed.ok) return refuse(listed.error);
    const discord = await readPlatform("discord.link.read", {});
    if (!discord.ok) return refuse(discord.error);
    return done({
        ...preferences.value.product_status,
        ticketReply: {
            inbox: preferences.value.ticket_reply.inbox,
            mail: preferences.value.ticket_reply.mail,
        },
        securityDiscord: preferences.value.security.discord,
        discordLinked: discord.value.linkedAt !== null,
        products: listed.value.products.map(({ productId, name }) => ({
            productId,
            name,
            following: preferences.value.subscriptions.includes(productId),
        })),
    });
});

export const savePreference = createServerFn({ method: "POST" })
    .validator((data: unknown) => SetPreference.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("preferences.channels.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const saveSubscription = createServerFn({ method: "POST" })
    .validator((data: unknown) => SetSubscription.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("preferences.subscriptions.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
