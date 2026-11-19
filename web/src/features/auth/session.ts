import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { pagePaths } from "../../pages.ts";
import { safeReturnTo } from "../../return-to.ts";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { clearSessionToken, patchFlow, readFlow } from "../../server/cookies.ts";
import { callPlatform } from "../../server/platform.ts";

function publicOrigin(): string {
    const config = readWebConfig(processEnvironment());
    return config.ok ? config.value.publicOrigin : "http://localhost";
}

// A member page sent an anonymous visitor to sign in: remember where they were going.
export const rememberReturnTo = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ href: z.string().max(512) }).parse(data))
    .handler(({ data }) => {
        patchFlow({ returnTo: data.href });
    });

// Where a member lands after signing in: the remembered page if it's still a safe one, else home.
// Reading it uses it up.
export const landing = createServerFn({ method: "POST" }).handler((): string => {
    const to = safeReturnTo(readFlow().returnTo, publicOrigin(), pagePaths());
    patchFlow({ returnTo: null });
    return to;
});

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
    await callPlatform("session.end", { sessionId: null }, { whenSignedOut: "return" });
    clearSessionToken();
    patchFlow({ signIn: null, passkey: null, stepUp: null, register: null, setup: null });
});
