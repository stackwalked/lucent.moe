import { AccountId } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../../server/platform.ts";

export const fetchInviteTree = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("admin.invites.tree", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

// Part of the account page: a refusal here leaves the rest of the page standing.
export const fetchInviteStanding = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ accountId: AccountId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.invites.account", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const grantInvites = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ accountId: AccountId, granted: z.number().int().min(0).max(1000) })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("admin.invites.grant", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
