import { ProductId } from "@lucent/core/scalars";
import { ChangelogSubject } from "@lucent/rpc/web/record";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { readPlatform } from "../../server/platform.ts";

export const fetchChangelog = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z
            .strictObject({
                productId: ProductId.nullable().optional(),
                subject: ChangelogSubject.optional(),
                cursor: z.string().optional(),
            })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("record.changelog.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const fetchRecordStatus = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("record.status.get", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});
