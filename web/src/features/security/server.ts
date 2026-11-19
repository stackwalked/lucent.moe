import { SessionId } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { clearSessionToken, patchFlow } from "../../server/cookies.ts";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

export const listSessions = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await callPlatform("session.list", {});
    return reply.ok ? done(reply.value.sessions) : refuse(reply.error);
});

export const endSession = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ sessionId: SessionId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("session.end", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const endOtherSessions = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("session.endOthers", {});
    return reply.ok ? done(null) : refuse(reply.error);
});

// A credential change needs a factor proven in the last five minutes, and an account without a
// passkey can only prove one by signing in again: this session ends, and sign-in brings the
// member back here.
export const signInAgain = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ returnTo: z.string().max(512) }).parse(data))
    .handler(async ({ data }) => {
        await callPlatform("session.end", { sessionId: null }, { whenSignedOut: "return" });
        clearSessionToken();
        patchFlow({ returnTo: data.returnTo });
    });
