import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

// What the privacy page shows: standing, blocks and who may open the profile. The visibility is
// the profile's own, so it is read through the profile.
export const fetchPrivacy = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ username: z.string().max(64).nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const restrictions = await readPlatform("privacy.restrictions.list", {});
        if (!restrictions.ok) return refuse(restrictions.error);
        const blocks = await readPlatform("privacy.blocks.list", {});
        if (!blocks.ok) return refuse(blocks.error);
        const deletion = await readPlatform("deletion.request.read", {});
        if (!deletion.ok) return refuse(deletion.error);
        const profile =
            data.username === null
                ? null
                : await readPlatform("profile.get", { username: data.username });
        return done({
            restrictions: restrictions.value.restrictions,
            blocks: blocks.value.blocks,
            deletion: deletion.value,
            visibility: profile?.ok === true ? profile.value.visibility : ("members" as const),
        });
    });

export const blockAccount = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z
            .strictObject({ username: z.string().trim().min(1).max(64), blocked: z.boolean() })
            .parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("privacy.blocks.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const saveVisibility = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ visibility: z.enum(["members", "private"]) }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("privacy.visibility.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const fetchExport = createServerFn({ method: "GET" }).handler(async () => {
    const reply = await readPlatform("privacy.export.read", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

// Deletion from a member session; the appeal session's pair follows.
export const askDeletion = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("deletion.request.create", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const keepAccount = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("deletion.request.cancel", {});
    return reply.ok ? done(null) : refuse(reply.error);
});

export const askAppealDeletion = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("appeals.deletion.request", {});
    return reply.ok ? done(reply.value) : refuse(reply.error);
});

export const keepAppealAccount = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("appeals.deletion.cancel", {});
    return reply.ok ? done(null) : refuse(reply.error);
});
