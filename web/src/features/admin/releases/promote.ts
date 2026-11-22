import { ChannelId, ProductId } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform } from "../../../server/platform.ts";

const SealNumber = z.string().regex(/^[1-9][0-9]{0,18}$/);
const ReleaseId = z.string().regex(/^[0-9a-f]{32}$/);
const SetId = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const promoteRelease = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ productId: ProductId, channel: ChannelId, number: SealNumber })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.releases.promote", data);
        return reply.ok ? done(reply.value.changed) : refuse(reply.error);
    });

export const promoteFactSet = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ releaseId: ReleaseId, setId: SetId }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.facts.promote", data);
        return reply.ok ? done(reply.value.changed) : refuse(reply.error);
    });
