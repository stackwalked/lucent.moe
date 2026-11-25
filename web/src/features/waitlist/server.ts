import { webContract } from "@lucent/rpc/web";
import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform } from "../../server/platform.ts";

// A public page: without the list it shows no form, never a refusal.
export const fetchOffered = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await callPlatform("waitlist.products.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const submitApplication = createServerFn({ method: "POST" })
    .validator((data: unknown) => webContract["waitlist.application.submit"].input.parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("waitlist.application.submit", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
