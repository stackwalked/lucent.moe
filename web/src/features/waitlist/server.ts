import { webContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

export const submitApplication = createServerFn({ method: "POST" })
    .validator((data: unknown) => webContract["waitlist.application.submit"].input.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("waitlist.application.submit", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
