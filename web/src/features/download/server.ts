import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const fetchLoaderOffer = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("download.loader", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});
