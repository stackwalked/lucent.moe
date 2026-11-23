import { EpochMs, ProductId } from "@lucent/core/scalars";
import { RestrictionKind } from "@lucent/rpc/web/community";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const listRestrictions = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ cursor: z.uuid().nullable() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.moderation.restrictions.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const restrictAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({
                username: z.string().max(64),
                kind: RestrictionKind,
                productId: ProductId.nullable(),
                reason: z.string().max(500),
                endsAt: EpochMs.nullable(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.moderation.restrictions.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const liftRestriction = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ id: z.uuid() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.moderation.restrictions.lift", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const listReports = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ cursor: z.uuid().nullable() }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("admin.moderation.reports.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const resolveReport = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ id: z.uuid(), outcome: z.enum(["remove", "dismiss"]) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.moderation.reports.resolve", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
