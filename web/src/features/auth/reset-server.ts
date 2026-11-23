import { BearerToken } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

export const requestReset = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ email: z.email().max(254) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("reset.password.request", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
export const redeemReset = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ token: BearerToken, password: z.string().min(1).max(1024) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("reset.password.redeem", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
