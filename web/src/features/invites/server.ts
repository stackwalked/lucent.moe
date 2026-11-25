import { BearerToken } from "@lucent/core/scalars";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

const InviteId = z.string().regex(/^[1-9][0-9]{0,18}$/);

export const fetchInvites = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("invites.mine.list", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

// The token comes back this once; the page builds the link from it.
export const createInvite = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("invites.mine.create", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const revokeInvite = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ inviteId: InviteId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("invites.mine.revoke", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const redeemInvite = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ token: BearerToken, email: z.email().max(254) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("invites.link.redeem", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
