import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listCrashSummaries } from "../../runtime/crashes.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const crashesHandlers = {
    "admin.crashes.summaries.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listCrashSummaries(ctx.auth.db, { caller, ...input })),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
