import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
    clearSessionToken,
    patchFlow,
    readFlow,
    readSessionToken,
    writeSessionToken,
} from "../../server/cookies.ts";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

// Whether a setup link's token is waiting in the flow cookie (GET /setup/<token> put it there).
export const setupLinkWaiting = createServerFn({ method: "GET" }).handler(
    (): boolean => readFlow().setup !== undefined,
);

// Using the link up: a POST, never a GET. Whoever was signed in here is signed out first, as the
// page said.
export const redeemSetup = createServerFn({ method: "POST" }).handler(async () => {
    const setupToken = readFlow().setup;
    if (setupToken === undefined) return refuse({ code: "SETUP_INVALID" });
    if (readSessionToken() !== null) {
        await callPlatform("session.end", { sessionId: null }, { whenSignedOut: "return" });
        clearSessionToken();
    }
    const reply = await callPlatform("setup.redeem", { setupToken });
    patchFlow({ setup: null });
    if (!reply.ok) return refuse(reply.error);
    writeSessionToken(reply.value.sessionToken, reply.value.expiresAt);
    return done(null);
});

export const chooseUsername = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("setup.username.choose", data);
        return reply.ok ? done(reply.value.username) : refuse(reply.error);
    });

// Setup is done: its session ends, and sign-in opens with the username filled in.
export const finishSetup = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        await callPlatform("session.end", { sessionId: null }, { whenSignedOut: "return" });
        clearSessionToken();
        patchFlow({ username: data.username });
    });
