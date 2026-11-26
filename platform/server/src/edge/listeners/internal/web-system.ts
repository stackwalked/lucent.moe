import type { Handlers } from "@lucent/rpc/mount";
import type { systemContract } from "@lucent/rpc/web/system";
import { readSystemStatus } from "../../../system/status.ts";
import { readUsage } from "../../../system/usage.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const systemHandlers = {
    "admin.system.status.read": (ctx, _input, call) =>
        asStaff(ctx, call, (caller) =>
            readSystemStatus(ctx.auth.db, { caller, artifactDir: ctx.artifactDir ?? null }),
        ),
    "admin.system.usage.read": (ctx, input, call) =>
        asStaff(ctx, call, (caller) =>
            readUsage(ctx.auth.db, { caller, endingWith: input.endingWith }),
        ),
} satisfies Handlers<WebRpcContext, typeof systemContract>;
