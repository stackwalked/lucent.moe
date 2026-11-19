import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const fetchProducts = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("products.list", {});
    return reply.ok ? done(reply.value.products) : refuse(reply.error);
});
