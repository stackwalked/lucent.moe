import { systemCryptoRng } from "@lucent/core/rng";
import { BearerToken, toBase64Url } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { patchFlow } from "../../server/cookies.ts";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";
import { discordAuthorizeUrl } from "./oauth.ts";

export const fetchDiscordLink = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("discord.link.read", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

// Sends the browser to Discord, with a state this browser will be asked for on the way back.
export const beginDiscordLink = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ for: z.enum(["apply", "account"]) }).parse(data))
    .handler(({ data }) => {
        const config = readWebConfig(processEnvironment());
        if (!config.ok || config.value.discordClientId === null) {
            return refuse({ code: "DISCORD_LINK_FAILED" });
        }
        const state = BearerToken.parse(toBase64Url(systemCryptoRng.fillBytes(new Uint8Array(32))));
        patchFlow({ discordState: state, discordFor: data.for });
        return done({
            url: discordAuthorizeUrl({
                clientId: config.value.discordClientId,
                publicOrigin: config.value.publicOrigin,
                state,
            }),
        });
    });

export const removeDiscordLink = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("discord.link.remove", {});
    return reply.ok ? done(null) : refuse(reply.error);
});
