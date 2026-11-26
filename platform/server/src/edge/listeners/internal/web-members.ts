import type { Handlers } from "@lucent/rpc/mount";
import type { membersContract } from "@lucent/rpc/web/members";
import { listMembers } from "../../../members/community/directory.ts";
import { served, type WebRpcContext } from "./web-shared.ts";

export const membersHandlers = {
    "members.list": async (ctx, input, { session }) =>
        served(await listMembers(ctx.auth.db, session, input)),
} satisfies Handlers<WebRpcContext, typeof membersContract>;
