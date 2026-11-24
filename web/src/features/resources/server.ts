import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const fetchResources = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("resources.list", {});
    return reply.ok ? done(reply.value.items) : refuse(reply.error);
});
