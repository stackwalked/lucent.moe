import type { BearerToken, EpochMs } from "@lucent/core/scalars";
import { AuthenticationResponse } from "@lucent/rpc/webauthn";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { pagePaths } from "../../pages.ts";
import { safeReturnTo } from "../../return-to.ts";
import { processEnvironment, readWebConfig } from "../../server/config.ts";
import { patchFlow, readFlow, writeSessionToken } from "../../server/cookies.ts";
import { done, type Outcome, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";
import { APPEAL_PATH } from "../appeal/path.ts";

// The sign-in steps. Platform's flow tokens stay in the flow cookie, never in the page: a
// password sign-in's in "signIn", a passkey-only one's in "passkey", so the autofill request
// waiting in the background and a typed password don't overwrite each other.

function publicOrigin(): string {
    const config = readWebConfig(processEnvironment());
    return config.ok ? config.value.publicOrigin : "http://localhost";
}

// Every factor passed: the session cookie, and where to go (used up as it's read). A suspended
// account's session reaches its appeal and nothing else, so that's where it goes.
function signedIn(session: {
    readonly sessionToken: BearerToken;
    readonly expiresAt: EpochMs;
    readonly purpose: "member" | "appeal";
}): Outcome<string> {
    writeSessionToken(session.sessionToken, session.expiresAt);
    const to =
        session.purpose === "appeal"
            ? APPEAL_PATH
            : safeReturnTo(readFlow().returnTo, publicOrigin(), pagePaths());
    patchFlow({ signIn: null, passkey: null, returnTo: null });
    return done(to);
}

const Password = z.strictObject({ username: z.string().max(64), password: z.string().max(1_024) });

export const signInWithPassword = createServerFn({ method: "POST" })
    .validator((data: unknown) => Password.parse(data))
    .handler(
        async ({
            data,
        }): Promise<
            Outcome<
                | {
                      readonly next: "secondFactor";
                      readonly secondFactors: readonly ("totp" | "passkey")[];
                  }
                | { readonly next: "arrive"; readonly to: string }
            >
        > => {
            patchFlow({ username: data.username });
            const reply = await callPlatform("signIn.password", data);
            if (!reply.ok) return refuse(reply.error);
            // A dev server with LUCENT_DEV_PASSWORD_ONLY signs in on the password alone.
            if (reply.value.next === "signedIn") {
                const arrived = signedIn(reply.value);
                return arrived.ok ? done({ next: "arrive", to: arrived.value }) : arrived;
            }
            patchFlow({ signIn: reply.value.flowToken });
            return done({ next: "secondFactor", secondFactors: reply.value.secondFactors });
        },
    );

export const signInWithCode = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ code: z.string().max(16) }).parse(data))
    .handler(async ({ data }): Promise<Outcome<string>> => {
        const flowToken = readFlow().signIn;
        if (flowToken === undefined) return refuse({ code: "FLOW_INVALID" });
        const reply = await callPlatform("signIn.totp", { flowToken, code: data.code });
        if (!reply.ok) {
            if (reply.error.code === "FLOW_INVALID") patchFlow({ signIn: null });
            return refuse(reply.error);
        }
        return signedIn(reply.value);
    });

const Mode = z.enum(["passkey-only", "second-factor"]);

export const beginPasskey = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ mode: Mode }).parse(data))
    .handler(async ({ data }) => {
        const flowToken = data.mode === "second-factor" ? (readFlow().signIn ?? null) : null;
        if (data.mode === "second-factor" && flowToken === null)
            return refuse({ code: "FLOW_INVALID" });
        const reply = await callPlatform("signIn.passkey.begin", { flowToken });
        if (!reply.ok) return refuse(reply.error);
        if (data.mode === "passkey-only") patchFlow({ passkey: reply.value.flowToken });
        return done(reply.value.options);
    });

export const finishPasskey = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ mode: Mode, response: AuthenticationResponse }).parse(data),
    )
    .handler(async ({ data }): Promise<Outcome<string>> => {
        const flow = readFlow();
        const flowToken = data.mode === "second-factor" ? flow.signIn : flow.passkey;
        if (flowToken === undefined) return refuse({ code: "FLOW_INVALID" });
        const reply = await callPlatform("signIn.passkey.finish", {
            flowToken,
            response: data.response,
        });
        if (!reply.ok) {
            if (reply.error.code === "FLOW_INVALID") {
                patchFlow(data.mode === "second-factor" ? { signIn: null } : { passkey: null });
            }
            return refuse(reply.error);
        }
        return signedIn(reply.value);
    });

// The username to fill in: the one just typed, or the one setup chose.
export const rememberedUsername = createServerFn({ method: "GET" }).handler(
    (): string => readFlow().username ?? "",
);
