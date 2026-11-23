import { ProductId } from "@lucent/core/scalars";
import { ContentId } from "@lucent/rpc/web/community";
import { GuideBody, GuideTitle } from "@lucent/rpc/web/guides";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchGuides = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ productId: ProductId, cursor: ContentId.nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("guides.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchGuide = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ id: ContentId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("guides.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const publishGuide = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ productId: ProductId, title: GuideTitle, body: GuideBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("guides.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const saveGuide = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ id: ContentId, title: GuideTitle, body: GuideBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("guides.update", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
