import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { callPlatform } from "../../server/platform.ts";

// The 64 px picture's digest for the bar's avatar. The session doesn't carry it, so it is read
// from the viewer's own profile; the bar shows no picture rather than fail when that can't be had.
export const fetchOwnAvatar = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.get", data, { whenSignedOut: "return" });
        return reply.ok ? (reply.value.avatar?.small ?? null) : null;
    });
