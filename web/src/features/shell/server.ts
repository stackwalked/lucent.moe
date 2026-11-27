import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { callPlatform } from "../../server/platform.ts";

// The 64 px picture's digest for the bar's avatar. The session doesn't carry it, so it is read
// from the viewer's own profile; the bar shows no picture rather than fail when that can't be had.
export const fetchOwnAvatar = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.get", data, { whenSignedOut: "return" });
        return reply.ok ? (reply.value.avatar?.small ?? null) : null;
    });

// What the site knows about itself from its configuration: the one origin pages are served from
// and the community server's invite link, when there is one. Neither changes while it runs.
export const fetchSite = createServerFn({ method: "GET" }).handler(() => {
    const config = readWebConfig(processEnvironment());
    return config.ok
        ? { origin: config.value.publicOrigin, discordInvite: config.value.discordInvite }
        : { origin: "http://localhost", discordInvite: null };
});
