import { ContentId } from "@lucent/rpc/web/community";
import { Bio, CommentBody } from "@lucent/rpc/web/profile";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchProfile = createServerFn({ method: "GET" })
    .validator((data: unknown) => z.strictObject({ username: z.string().max(64) }).parse(data))
    .handler(async ({ data }) => {
        const reply = await readPlatform("profile.get", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const removeAvatar = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("profile.avatar.clear", {});
    return reply.ok ? done(null) : refuse(reply.error);
});

export const saveBio = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ bio: Bio }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.bio.set", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });

export const removeBanner = createServerFn({ method: "POST" }).handler(async () => {
    const reply = await callPlatform("profile.banner.clear", {});
    return reply.ok ? done(null) : refuse(reply.error);
});

export const fetchWall = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ username: z.string().max(64), cursor: ContentId.nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("profile.comments.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const postWallComment = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ username: z.string().max(64), body: CommentBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.comments.create", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const removeWallComment = createServerFn({ method: "POST" })
    .validator((data: unknown) => z.strictObject({ id: ContentId }).parse(data))
    .handler(async ({ data }) => {
        const reply = await callPlatform("profile.comments.delete", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
