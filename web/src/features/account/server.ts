import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { listCredentials } from "../credentials/server.ts";
import { fetchDevices } from "../devices/server.ts";
import { fetchDiscordLink } from "../discord/server.ts";
import { fetchInvites } from "../invites/server.ts";
import { fetchPreferences } from "../preferences/server.ts";
import { fetchPrivacy } from "../privacy/server.ts";
import { listSessions } from "../security/server.ts";

// The account page reads everything it shows at once, each part answering for itself: one
// refused read leaves its block saying so, not the page.
export const fetchAccount = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ username: z.string().max(64).nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const [credentials, sessions, devices, invites, discord, preferences, privacy] =
            await Promise.all([
                listCredentials(),
                listSessions(),
                fetchDevices(),
                fetchInvites(),
                fetchDiscordLink(),
                fetchPreferences(),
                fetchPrivacy({ data }),
            ]);
        const config = readWebConfig(processEnvironment());
        const discordConfigured = config.ok && config.value.discordClientId !== null;
        return {
            credentials,
            sessions,
            devices,
            invites,
            discord,
            discordConfigured,
            preferences,
            privacy,
        };
    });
