import { AuthenticationResponse, RegistrationResponse } from "@lucent/rpc/webauthn";
import { createServerFn } from "@tanstack/react-start";
import { encode } from "uqr";
import { z } from "zod";
import { patchFlow, readFlow } from "../../server/cookies.ts";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

// Adding and removing ways to sign in, for setup and the security page alike. Each call carries
// the session cookie; platform decides whether it's fresh enough (REAUTH_REQUIRED if not).

export const listCredentials = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await callPlatform("credentials.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const setPassword = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ password: z.string().max(1_024) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("credentials.password.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

// The QR code is drawn on the server, as rows of "1" and "0" the page turns into an SVG path:
// no QR code runs in the browser, and no markup crosses as a string.
export const enrollTotp = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("credentials.totp.enroll", {});
    if (!reply.ok) return refuse(reply.error);
    const qr = encode(reply.value.uri, { ecc: "M", border: 0 });
    return done({
        secret: reply.value.secret,
        rows: qr.data.map((row) => row.map((dark) => (dark ? "1" : "0")).join("")),
    });
});

export const confirmTotp = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ code: z.string().max(16) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("credentials.totp.confirm", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const beginPasskeyRegistration = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("credentials.passkey.register.begin", {});
    if (!reply.ok) return refuse(reply.error);
    patchFlow({ register: reply.value.flowToken });
    return done(reply.value.options);
});

export const finishPasskeyRegistration = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ label: z.string().max(64), response: RegistrationResponse }).parse(data),
    )
    .handler(async ({ data }) => {
        const flowToken = readFlow().register;
        if (flowToken === undefined) return refuse({ code: "FLOW_INVALID" });
        const reply = await callPlatform("credentials.passkey.register.finish", {
            flowToken,
            ...data,
        });
        patchFlow({ register: null });
        return reply.ok ? done(reply.value.id) : refuse(reply.error);
    });

const CredentialRef = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("passkey"), id: z.string().max(1_366) }),
    z.strictObject({ kind: z.literal("password") }),
    z.strictObject({ kind: z.literal("totp") }),
]);

export const removeCredential = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ credential: CredentialRef }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("credentials.remove", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const beginStepUp = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("stepUp.begin", {});
    if (!reply.ok) return refuse(reply.error);
    patchFlow({ stepUp: reply.value.flowToken });
    return done(reply.value.options);
});

export const finishStepUp = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ response: AuthenticationResponse }).parse(data))
    .handler(async ({ data }) => {
        const flowToken = readFlow().stepUp;
        if (flowToken === undefined) return refuse({ code: "FLOW_INVALID" });
        const reply = await callPlatform("stepUp.finish", {
            flowToken,
            response: data.response,
        });
        patchFlow({ stepUp: null });
        return reply.ok ? done(null) : refuse(reply.error);
    });
