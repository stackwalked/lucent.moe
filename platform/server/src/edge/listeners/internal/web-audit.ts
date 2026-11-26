import type { Handlers } from "@lucent/rpc/mount";
import type { WebContract } from "@lucent/rpc/web";
import { listAudit } from "../../../identity/authority/reads.ts";
import { asStaff, type WebRpcContext } from "./web-shared.ts";

export const auditHandlers = {
    "admin.audit.list": (ctx, input, call) =>
        asStaff(ctx, call, (caller) => listAudit(ctx.auth.db, { caller, ...input })),
} satisfies Partial<Handlers<WebRpcContext, WebContract>>;
