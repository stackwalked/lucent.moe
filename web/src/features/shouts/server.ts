import { ProductId } from "@lucent/core/scalars";
import { ContentId } from "@lucent/rpc/web/community";
import { ShoutBody } from "@lucent/rpc/web/shouts";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchShouts = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({ productId: ProductId.nullable(), cursor: ContentId.nullable() })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("shouts.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const postShout = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ productId: ProductId.nullable(), body: ShoutBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("shouts.create", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const removeShout = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ id: ContentId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("shouts.delete", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

// Staff's purge: every shout of one account, or the newest N. How many went is not shown.
export const purgeShouts = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .union([
                z.strictObject({ username: z.string().min(1).max(64) }),
                z.strictObject({ last: z.number().int().min(1).max(100) }),
            ])
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.shouts.purge", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
