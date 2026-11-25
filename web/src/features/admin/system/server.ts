import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../../server/outcome.ts";
import { readPlatform } from "../../../server/platform.ts";

export const readSystemStatus = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.system.status.read", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

// The twelve weeks up to now; the contract can name an earlier week when a page needs one.
export const readUsage = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.system.usage.read", { endingWith: null });
    return reply.ok ? done(reply.value) : refuse(reply.error);
});
