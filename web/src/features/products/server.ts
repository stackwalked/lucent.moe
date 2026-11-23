import { createServerFn } from "@tanstack/react-start";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchPublicProducts = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await callPlatform("catalog.products.list", {});
    if (!reply.ok) return refuse(reply.error);
    return done(reply.value.map(({ id, name, state }) => ({ id, name, state })));
});

export const fetchProducts = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("products.list", {});
    return reply.ok ? done(reply.value.products) : refuse(reply.error);
});
