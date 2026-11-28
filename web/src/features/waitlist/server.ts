import { webContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { clearAppliedDiscord, readAppliedDiscord } from "../../server/cookies.ts";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

// What the page needs to pick its step, from this site's own configuration and the browser's
// cookie: no call to platform, so the page renders through its outages.
export const fetchApplyStep = createServerFn({ method: "GET" }).handler(() => {
    const config = readWebConfig(processEnvironment());
    const discordRequired = config.ok && config.value.discordClientId !== null;
    return {
        discordRequired,
        discordUsername: discordRequired ? (readAppliedDiscord()?.username ?? null) : null,
    };
});

// The browser never holds the claim in script: it is in a cookie, and joins the form here.
export const submitApplication = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        webContract["waitlist.application.submit"].input.omit({ discordClaim: true }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("waitlist.application.submit", {
            ...data,
            discordClaim: readAppliedDiscord()?.claim ?? null,
        });
        if (reply.ok) {
            clearAppliedDiscord();
            return done(null);
        }
        if (reply.error.code === "DISCORD_LINK_REQUIRED") clearAppliedDiscord();
        return refuse(reply.error);
    });
