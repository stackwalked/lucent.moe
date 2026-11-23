import { CommentBody } from "@lucent/rpc/web/comments";
import { ContentId } from "@lucent/rpc/web/community";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { done, refuse } from "../../server/outcome.ts";
import { callPlatform, readPlatform } from "../../server/platform.ts";

export const fetchComments = createServerFn({ method: "GET" })
    .validator((data: unknown) =>
        z.strictObject({ guideId: ContentId, cursor: ContentId.nullable() }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await readPlatform("comments.list", data);
        return reply.ok ? done(reply.value) : refuse(reply.error);
    });

export const postComment = createServerFn({ method: "POST" })
    .validator((data: unknown) =>
        z.strictObject({ guideId: ContentId, body: CommentBody }).parse(data),
    )
    .handler(async ({ data }) => {
        const reply = await callPlatform("comments.create", data);
        return reply.ok ? done(null) : refuse(reply.error);
    });
